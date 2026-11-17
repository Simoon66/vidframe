import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMediaItem,
  getMediaVersion,
  listMediaVersions,
  updateMediaItem,
  getShardedViewTotal,
  recordViewEvent,
  incrementShardedView,
} from '../db.ts';
import { getStorageAdapter } from '../storage/storageRouter.ts';
import {
  mintSignedPlaybackToken,
  verifySignedPlaybackToken,
  rewriteHlsManifestWithToken,
  getCdnCacheHeaders,
} from '../security/signedUrls.ts';
import { applyWebVttOffset } from '../workers/mediaPipeline.ts';

export const cdnRouter = Router();

// Public/Token-Protected Playback Descriptor endpoint used by WatchPage, EmbedPage & PreviewModal
cdnRouter.get('/media/:mediaId/playback', async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const media = await getMediaItem(mediaId);
  if (!media) {
    return res.status(404).json({ error: 'Media not found' });
  }

  // Enforce private visibility unless caller is authenticated admin/editor or has a valid token
  const explicitToken = typeof req.query.token === 'string' ? req.query.token : '';
  const activeVersionId = media.activeVersionId || '';

  if (media.visibility === 'private' && !req.authCtx) {
    if (!explicitToken || !activeVersionId) {
      return res.status(403).json({ error: 'This video is private and requires authorization or a signed playback link.' });
    }
    const check = verifySignedPlaybackToken(explicitToken, mediaId, activeVersionId);
    if (!check.valid) {
      return res.status(403).json({ error: check.reason || 'Invalid playback token for private media.' });
    }
  }

  // Optional domain allowlist check against Origin / Referer
  if (media.allowedDomains && media.allowedDomains.length > 0 && !req.authCtx) {
    const referer = req.headers.referer || req.headers.origin || '';
    try {
      const host = referer ? new URL(referer).hostname.toLowerCase() : '';
      const selfHost = req.hostname?.toLowerCase() || '';
      const allowed = media.allowedDomains.some((d) => {
        const clean = d.trim().toLowerCase();
        return host === clean || host.endsWith(`.${clean}`) || host === selfHost;
      });
      if (host && !allowed) {
        return res.status(403).json({ error: `Embed domain '${host}' is not on the media allowlist.` });
      }
    } catch {}
  }

  const version = activeVersionId ? await getMediaVersion(activeVersionId) : null;
  const versions = await listMediaVersions(mediaId).catch(() => []);
  const shardedViews = await getShardedViewTotal(mediaId).catch(() => 0);
  const totalViews = Math.max(media.views || 0, shardedViews);

  let signedToken: string | undefined;
  let hlsManifestUrl: string | undefined;

  if (media.playbackMode === 'hls_v2' && version && version.masterPlaylistKey && version.status === 'ready') {
    if (media.visibility === 'private' || media.requireSignedPlayback || explicitToken) {
      signedToken = explicitToken || mintSignedPlaybackToken(mediaId, version.id);
    } else {
      // Mint short-lived token when signing is configured or leave signed cleanly for protected CDN origin
      signedToken = mintSignedPlaybackToken(mediaId, version.id);
    }
    hlsManifestUrl = `/api/cdn/v1/hls/${mediaId}/${version.id}/master.m3u8${signedToken ? `?token=${encodeURIComponent(signedToken)}` : ''}`;
  }

  const legacyTokenQuery =
    media.visibility === 'private' && version
      ? `?token=${encodeURIComponent(signedToken || mintSignedPlaybackToken(mediaId, version.id))}`
      : '';
  const legacyStreamUrl = `/api/media/${mediaId}/stream${legacyTokenQuery}`;

  const posterUrl =
    version?.posterKey
      ? `/api/cdn/v1/hls/${mediaId}/${version.id}/poster.jpg${signedToken ? `?token=${encodeURIComponent(signedToken)}` : ''}`
      : media.posterUrl;

  const subtitleTracks = (media.subtitleTracks || []).map((sub) => {
    if (!sub.url) return sub;
    if (sub.url.includes('/api/cdn/v1/hls/') && signedToken && !sub.url.includes('token=')) {
      return { ...sub, url: `${sub.url}${sub.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(signedToken)}` };
    }
    return sub;
  });

  res.json({
    media: { ...media, views: totalViews },
    playbackMode: hlsManifestUrl ? 'hls_v2' : 'legacy_telegram',
    hlsManifestUrl,
    legacyStreamUrl,
    signedToken,
    posterUrl,
    renditions: version?.renditions || [],
    audioTracks: version?.audioTracks || media.audioTracks || [],
    subtitleTracks,
    chapters: media.chapters || [],
    versionsCount: versions.length,
    activeVersionId: version?.id,
  });
});

// Mint fresh signed playback URL for authorized admins/editors or scoped playback API keys
cdnRouter.post('/media/:mediaId/sign-playback', async (req: Request, res: Response) => {
  if (!req.authCtx) {
    return res.status(401).json({ error: 'Authentication required to mint signed playback grants.' });
  }
  const { mediaId } = req.params;
  const ttlSeconds = Number(req.body?.ttlSeconds || 3600);
  const media = await getMediaItem(mediaId);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const versionId = req.body?.versionId || media.activeVersionId || 'v1';
  const token = mintSignedPlaybackToken(mediaId, versionId, ttlSeconds);
  const hlsUrl = `/api/cdn/v1/hls/${mediaId}/${versionId}/master.m3u8?token=${encodeURIComponent(token)}`;
  res.json({ success: true, token, expiresInSeconds: ttlSeconds, hlsUrl });
});

// Authoritative Signed HLS Origin Delivery Endpoint (Manifests, Variants, Audio Groups, TS/fMP4 Segments, VTT Subtitles, Posters)
cdnRouter.get('/cdn/v1/hls/:mediaId/:versionId/*', async (req: Request, res: Response) => {
  const { mediaId, versionId } = req.params;
  const relPath = (req.params[0] || '').replace(/^\/+/, '');
  if (!relPath || relPath.includes('..')) {
    return res.status(400).send('Invalid asset path');
  }

  const media = await getMediaItem(mediaId);
  if (!media) return res.status(404).send('Media not found');
  const version = await getMediaVersion(versionId);
  if (!version || version.mediaId !== mediaId) return res.status(404).send('Media version not found');

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const requiresSignature = media.visibility === 'private' || Boolean(media.requireSignedPlayback);
  if (requiresSignature && !req.authCtx) {
    const verification = verifySignedPlaybackToken(token, mediaId, versionId);
    if (!verification.valid) {
      return res.status(403).json({ error: verification.reason || 'Signed playback token invalid or expired.' });
    }
  } else if (token) {
    const verification = verifySignedPlaybackToken(token, mediaId, versionId);
    if (!verification.valid) {
      return res.status(403).json({ error: verification.reason || 'Signed playback token invalid or expired.' });
    }
  }

  const objectKey = `${version.objectPrefix}/${relPath}`;
  const ext = path.extname(relPath).toLowerCase();
  const isPlaylist = ext === '.m3u8';

  res.setHeader('Cache-Control', getCdnCacheHeaders(media.visibility, isPlaylist));
  res.setHeader('Vary', 'Authorization, Origin');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const adapter = await getStorageAdapter(version.storageBackend);

    if (isPlaylist) {
      const text = await adapter.getObjectText(objectKey);
      const subdir = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
      const rewritten = rewriteHlsManifestWithToken(text, subdir, mediaId, versionId, token || undefined);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.send(rewritten);
    }

    if (ext === '.vtt') {
      let vttText = await adapter.getObjectText(objectKey);
      const offsetMs = Number(req.query.offsetMs || 0);
      if (offsetMs && !isNaN(offsetMs)) {
        vttText = applyWebVttOffset(vttText, offsetMs);
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(vttText);
    }

    const contentType =
      ext === '.ts'
        ? 'video/mp2t'
        : ext === '.m4s' || ext === '.mp4'
        ? 'video/mp4'
        : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'application/octet-stream';

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1]!, 10);
        const end = m[2] ? parseInt(m[2], 10) : undefined;
        const obj = await adapter.getObjectStream(objectKey, { start, end });
        const total = obj.size;
        const actualEnd = end !== undefined ? Math.min(total - 1, end) : total - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${actualEnd}/${total}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', actualEnd - start + 1);
        res.setHeader('Content-Type', contentType);
        return obj.stream.pipe(res);
      }
    }

    const obj = await adapter.getObjectStream(objectKey);
    res.setHeader('Accept-Ranges', 'bytes');
    if (obj.size > 0) res.setHeader('Content-Length', obj.size);
    res.setHeader('Content-Type', contentType);
    return obj.stream.pipe(res);
  } catch (err: any) {
    return res.status(404).json({ error: err?.message || 'HLS artifact unavailable' });
  }
});

// Serve manually uploaded/AI WebVTT files stored in public_subtitles with optional sync offset
cdnRouter.get('/media/:mediaId/subtitles/file/:filename', async (req: Request, res: Response) => {
  const { mediaId, filename } = req.params;
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const subDir = path.resolve(process.cwd(), 'public_subtitles');
  const fullPath = path.join(subDir, `${mediaId}_${safeName}`);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('Subtitle file not found');
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  const offsetMs = Number(req.query.offsetMs || 0);
  if (offsetMs && !isNaN(offsetMs)) {
    content = applyWebVttOffset(content, offsetMs);
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.send(content);
});

void updateMediaItem;
void recordViewEvent;
void incrementShardedView;
