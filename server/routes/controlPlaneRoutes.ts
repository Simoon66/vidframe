import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { APP_CONFIG, getFirebaseConfig } from '../config.ts';
import {
  getMediaItem,
  updateMediaItem,
  listMediaVersions,
  getMediaVersion,
  saveMediaVersion,
  listIntroSuggestions,
  getIntroSuggestion,
  saveIntroSuggestion,
  listAdminUsers,
  saveAdminUser,
  deleteAdminUser,
  listApiKeys,
  saveApiKeyRecord,
  revokeApiKey,
  listAuditLogs,
  MediaVersionRecord,
  SubtitleTrackMeta,
} from '../db.ts';
import { requireAuth, recordAudit } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import {
  getTelemetrySummary,
  getReadinessReport,
  recordClientPlaybackTelemetry,
} from '../observability/telemetry.ts';
import {
  testAndSaveS3Config,
  switchActiveStorageBackend,
  getStorageAdapter,
} from '../storage/storageRouter.ts';
import { queueManager } from '../queue/queueManager.ts';
import {
  convertSubtitleFileToVtt,
  applyWebVttOffset,
  probeMediaFull,
} from '../workers/mediaPipeline.ts';
import { computeFileSha256, sha256Hex } from '../crypto.ts';
import { listAvailableAiProviders } from '../ai/externalProviders.ts';
import { safeProbeMediaUrl } from '../security/ssrfGuard.ts';

export const controlPlaneRouter = Router();

const subUploadDir = path.resolve(process.cwd(), 'temp_uploads');
if (!fs.existsSync(subUploadDir)) fs.mkdirSync(subUploadDir, { recursive: true });
const subUpload = multer({ dest: subUploadDir, limits: { fileSize: 25 * 1024 * 1024 } });
const masterUpload = multer({ dest: subUploadDir, limits: { fileSize: 10000 * 1024 * 1024 } });

// ==================== HEALTH, READINESS & TELEMETRY ====================

controlPlaneRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'vidframe-cdn',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

controlPlaneRouter.get('/ready', requireAuth(['admin', 'editor']), async (_req: Request, res: Response) => {
  try {
    const report = await getReadinessReport();
    res.status(report.ready ? 200 : 503).json(report);
  } catch (err: any) {
    res.status(503).json({ ready: false, error: err?.message || 'Readiness check failed' });
  }
});

controlPlaneRouter.get('/telemetry', requireAuth(['admin', 'editor']), async (_req: Request, res: Response) => {
  const report = await getReadinessReport();
  const cfg = getFirebaseConfig();
  res.json({
    ...report,
    projectId: cfg.projectId,
    firestoreDatabaseId: cfg.firestoreDatabaseId,
    queueDriver: queueManager.getDriverName(),
    aiProviders: listAvailableAiProviders(),
    telemetry: getTelemetrySummary(),
  });
});

controlPlaneRouter.post('/telemetry/playback', rateLimit('general'), (req: Request, res: Response) => {
  const { mediaId, kind, detail } = req.body || {};
  if (!mediaId || (kind !== 'playback_error' && kind !== 'playback_buffer')) {
    return res.status(400).json({ error: 'Valid mediaId and telemetry kind required.' });
  }
  recordClientPlaybackTelemetry(String(mediaId), kind, typeof detail === 'string' ? detail : undefined);
  res.json({ success: true });
});

// ==================== STORAGE BACKEND MANAGEMENT (S3 / R2 / LOCAL_DEV / TELEGRAM) ====================

controlPlaneRouter.post('/storage/s3-test-save', requireAuth(['admin']), async (req: Request, res: Response) => {
  try {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey, cdnBaseUrl, forcePathStyle, activateAsDefault } =
      req.body || {};
    if (!endpoint || !bucket || !accessKeyId) {
      return res.status(400).json({ error: 'endpoint, bucket, and accessKeyId are required.' });
    }
    const result = await testAndSaveS3Config({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      cdnBaseUrl,
      forcePathStyle,
      activateAsDefault,
    });
    await recordAudit(req, 'storage.s3_configured', 'settings', 'storage', {
      bucket,
      endpoint,
      activated: Boolean(activateAsDefault),
    });
    res.json({ success: true, detail: result.detail, storage: result.sanitizedConfig });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to verify S3/R2 storage configuration.' });
  }
});

controlPlaneRouter.post('/storage/switch-backend', requireAuth(['admin']), async (req: Request, res: Response) => {
  try {
    const { backend } = req.body || {};
    if (backend !== 'telegram' && backend !== 's3_r2' && backend !== 'local_dev') {
      return res.status(400).json({ error: "Invalid storage backend. Expected 'telegram', 's3_r2', or 'local_dev'." });
    }
    const updated = await switchActiveStorageBackend(backend);
    await recordAudit(req, 'storage.switch_backend', 'settings', 'storage', { backend });
    res.json({ success: true, storage: updated });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to switch storage backend.' });
  }
});

// ==================== SMART URL INSPECTOR (SSRF-HARDENED) ====================

controlPlaneRouter.post(
  '/media/inspect-url',
  requireAuth(['admin', 'editor']),
  rateLimit('urlImport'),
  async (req: Request, res: Response) => {
    const { url } = req.body || {};
    if (!url || !String(url).trim()) {
      return res.status(400).json({ error: 'url is required' });
    }
    const result = await safeProbeMediaUrl(String(url).trim());
    if (!result.valid) {
      return res.status(400).json({ error: result.error || 'URL rejected by SSRF Guard', probe: result });
    }
    res.json({ success: true, probe: result });
  }
);

// ==================== MASTER VERSIONING & HLS PACKAGING ====================

controlPlaneRouter.get('/media/:mediaId/versions', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const versions = await listMediaVersions(mediaId);
  res.json({ versions });
});

controlPlaneRouter.post(
  '/media/:mediaId/versions',
  requireAuth(['admin', 'editor']),
  rateLimit('upload'),
  masterUpload.single('video'),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const media = await getMediaItem(mediaId);
    if (!media) {
      if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Media item not found.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No master video file uploaded.' });
    }

    const tempPath = req.file.path;
    try {
      const versions = await listMediaVersions(mediaId);
      const nextNum = versions.length > 0 ? Math.max(...versions.map((v) => v.versionNumber)) + 1 : 1;
      const versionId = `ver_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
      const sha256Hash = await computeFileSha256(tempPath);
      const probe = probeMediaFull(tempPath);
      const storageAdapter = await getStorageAdapter();
      const objectPrefix = `media/${mediaId}/${versionId}`;

      if (storageAdapter.mode === 's3_r2' || storageAdapter.mode === 'local_dev') {
        const ext = path.extname(req.file.originalname) || '.mp4';
        await storageAdapter.putFile(`${objectPrefix}/master_source${ext}`, tempPath, req.file.mimetype);
      } else {
        // Keep persistent local copy in stream_cache so background worker picks it up right away
        const streamCache = path.resolve(process.cwd(), 'stream_cache');
        if (!fs.existsSync(streamCache)) fs.mkdirSync(streamCache, { recursive: true });
        fs.copyFileSync(tempPath, path.join(streamCache, `source_${mediaId}_${versionId}.mkv`));
      }

      const now = new Date().toISOString();
      const newVersion: MediaVersionRecord = {
        id: versionId,
        mediaId,
        versionNumber: nextNum,
        label: String(req.body?.label || `v${nextNum} Master`).slice(0, 80),
        filename: req.file.originalname,
        mimeType: req.file.mimetype || 'video/mp4',
        size: req.file.size,
        duration: probe.duration,
        sha256Hash,
        storageBackend: storageAdapter.mode,
        objectPrefix,
        renditions: [],
        probeMetadata: {
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          bitrate: probe.bitrate,
        },
        audioTracks: probe.audioTracks,
        status: 'queued',
        createdBy: req.authCtx!.uid,
        createdAt: now,
        updatedAt: now,
      };

      await saveMediaVersion(newVersion);
      const { job } = await queueManager.enqueue({
        idempotencyKey: `hls_${mediaId}_${versionId}`,
        mediaId,
        versionId,
        jobType: 'transcode_hls',
        priority: 8,
        createdBy: req.authCtx!.uid,
      });

      await recordAudit(req, 'media.version_uploaded', 'media', mediaId, {
        versionId,
        versionNumber: nextNum,
        filename: req.file.originalname,
      });

      res.json({ success: true, version: newVersion, job });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to stage new master version.' });
    } finally {
      if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch {}
    }
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/versions/:versionId/activate',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const { mediaId, versionId } = req.params;
    const version = await getMediaVersion(versionId);
    if (!version || version.mediaId !== mediaId) {
      return res.status(404).json({ error: 'Version not found for this media.' });
    }
    if (version.status !== 'ready') {
      return res.status(400).json({ error: `Version is '${version.status}' and cannot be activated until HLS packaging completes.` });
    }

    const updated = await updateMediaItem(mediaId, {
      activeVersionId: version.id,
      playbackMode: version.masterPlaylistKey ? 'hls_v2' : 'legacy_telegram',
      storageBackend: version.storageBackend,
      duration: version.duration,
      sha256Hash: version.sha256Hash,
      audioTracks: version.audioTracks,
      subtitleTracks: version.subtitleTracks,
      posterUrl: version.posterKey ? `/api/cdn/v1/hls/${mediaId}/${version.id}/poster.jpg` : undefined,
    });

    await recordAudit(req, 'media.version_activated', 'media', mediaId, { versionId, versionNumber: version.versionNumber });
    res.json({ success: true, media: updated, activeVersion: version });
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/package-hls',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const media = await getMediaItem(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    const { job, deduplicated } = await queueManager.enqueue({
      idempotencyKey: `hls_repack_${mediaId}_${media.activeVersionId || 'v1'}`,
      mediaId,
      versionId: media.activeVersionId,
      jobType: 'transcode_hls',
      priority: 7,
      createdBy: req.authCtx!.uid,
    });

    await updateMediaItem(mediaId, { processingStatus: 'processing' });
    await recordAudit(req, 'media.hls_queued', 'media', mediaId, { jobId: job.id });
    res.json({ success: true, job, deduplicated });
  }
);

// ==================== SUBTITLE TRACK STUDIO (.SRT/.ASS/.VTT UPLOAD + OFFSET SYNC + FLAGS) ====================

controlPlaneRouter.post(
  '/media/:mediaId/subtitles/upload',
  requireAuth(['admin', 'editor']),
  subUpload.single('subtitle'),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const media = await getMediaItem(mediaId);
    if (!media) {
      if (req.file && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Media not found.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No subtitle file (.vtt, .srt, .ass) provided.' });
    }

    const tempPath = req.file.path;
    const subDir = path.resolve(process.cwd(), 'public_subtitles');
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

    const lang = String(req.body?.language || 'en').trim().toLowerCase().slice(0, 12);
    const title = String(req.body?.title || `${lang.toUpperCase()} Subtitles`).trim().slice(0, 80);
    const offsetMs = Number(req.body?.offsetMs || 0);
    const isDefault = req.body?.isDefault === 'true' || req.body?.isDefault === true;
    const isForced = req.body?.isForced === 'true' || req.body?.isForced === true;

    const fileName = `ext_${lang}_${Date.now()}.vtt`;
    const targetPath = path.join(subDir, `${mediaId}_${fileName}`);

    try {
      convertSubtitleFileToVtt(tempPath, targetPath);
      if (offsetMs && !isNaN(offsetMs)) {
        const shifted = applyWebVttOffset(fs.readFileSync(targetPath, 'utf8'), offsetMs);
        fs.writeFileSync(targetPath, shifted, 'utf8');
      }

      const vttContent = fs.readFileSync(targetPath, 'utf8');
      let objectKey: string | undefined;
      let publicUrl = `/api/media/${mediaId}/subtitles/file/${fileName}`;

      if (media.activeVersionId && (media.storageBackend === 's3_r2' || media.storageBackend === 'local_dev')) {
        const ver = await getMediaVersion(media.activeVersionId);
        if (ver) {
          const adapter = await getStorageAdapter(ver.storageBackend);
          objectKey = `${ver.objectPrefix}/${fileName}`;
          await adapter.putObject(objectKey, vttContent, 'text/vtt');
          publicUrl = `/api/cdn/v1/hls/${mediaId}/${ver.id}/${fileName}`;
        }
      }

      const existing = (media.subtitleTracks || []).map((t) =>
        isDefault ? { ...t, isDefault: false } : t
      );

      const nextTrack: SubtitleTrackMeta = {
        index: existing.length,
        language: lang,
        title,
        format: 'vtt',
        url: publicUrl,
        objectKey,
        isDefault,
        isForced,
        offsetMs: isNaN(offsetMs) ? 0 : offsetMs,
        source: 'uploaded',
      };

      const updated = await updateMediaItem(mediaId, {
        subtitleTracks: [...existing, nextTrack],
      });

      await recordAudit(req, 'media.subtitle_uploaded', 'media', mediaId, { language: lang, title });
      res.json({ success: true, track: nextTrack, media: updated });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to parse or convert subtitle file.' });
    } finally {
      if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch {}
    }
  }
);

controlPlaneRouter.patch(
  '/media/:mediaId/subtitles/:trackIndex',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const { mediaId, trackIndex } = req.params;
    const idx = Number(trackIndex);
    const media = await getMediaItem(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    const { isDefault, isForced, offsetMs, title } = req.body || {};
    const tracks = [...(media.subtitleTracks || [])];
    const targetIdx = tracks.findIndex((t) => t.index === idx);
    if (targetIdx === -1) return res.status(404).json({ error: 'Subtitle track not found' });

    const nextTracks = tracks.map((t, i) => {
      if (i !== targetIdx) {
        return isDefault === true ? { ...t, isDefault: false } : t;
      }
      return {
        ...t,
        title: typeof title === 'string' && title.trim() ? title.trim() : t.title,
        isDefault: typeof isDefault === 'boolean' ? isDefault : t.isDefault,
        isForced: typeof isForced === 'boolean' ? isForced : t.isForced,
        offsetMs: typeof offsetMs === 'number' ? offsetMs : t.offsetMs,
      };
    });

    const updated = await updateMediaItem(mediaId, { subtitleTracks: nextTracks });
    res.json({ success: true, media: updated });
  }
);

// ==================== AI STUDIO ENDPOINTS (TRANSCRIBE, TRANSLATE, INTRO/CHAPTERS) ====================

controlPlaneRouter.get('/ai/providers', requireAuth(['admin', 'editor']), (_req: Request, res: Response) => {
  res.json({ providers: listAvailableAiProviders() });
});

controlPlaneRouter.post(
  '/media/:mediaId/ai/transcribe',
  requireAuth(['admin', 'editor']),
  rateLimit('ai'),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const { provider = 'gemini', language } = req.body || {};
    const media = await getMediaItem(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found.' });

    const { job } = await queueManager.enqueue({
      idempotencyKey: `ai_trans_${mediaId}_${provider}_${language || 'auto'}`,
      mediaId,
      jobType: 'ai_transcribe',
      priority: 6,
      payload: { provider, language },
      createdBy: req.authCtx!.uid,
    });

    await recordAudit(req, 'ai.transcribe_queued', 'media', mediaId, { provider, language, jobId: job.id });
    res.json({ success: true, job });
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/ai/translate',
  requireAuth(['admin', 'editor']),
  rateLimit('ai'),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const { targetLanguage = 'Spanish', targetCode = 'es', sourceTrackIndex = 0 } = req.body || {};
    const media = await getMediaItem(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found.' });

    const { job } = await queueManager.enqueue({
      idempotencyKey: `ai_tr_${mediaId}_${targetCode}_${sourceTrackIndex}_${Date.now()}`,
      mediaId,
      jobType: 'ai_translate',
      priority: 5,
      payload: { targetLanguage, targetCode, sourceTrackIndex },
      createdBy: req.authCtx!.uid,
    });

    await recordAudit(req, 'ai.translate_queued', 'media', mediaId, { targetLanguage, jobId: job.id });
    res.json({ success: true, job });
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/ai/detect-chapters',
  requireAuth(['admin', 'editor']),
  rateLimit('ai'),
  async (req: Request, res: Response) => {
    const { mediaId } = req.params;
    const media = await getMediaItem(mediaId);
    if (!media) return res.status(404).json({ error: 'Media not found.' });

    const { job } = await queueManager.enqueue({
      idempotencyKey: `ai_chap_${mediaId}_${Date.now()}`,
      mediaId,
      jobType: 'detect_intro',
      priority: 6,
      createdBy: req.authCtx!.uid,
    });

    await recordAudit(req, 'ai.chapter_detection_queued', 'media', mediaId, { jobId: job.id });
    res.json({ success: true, job });
  }
);

controlPlaneRouter.get(
  '/media/:mediaId/ai/suggestions',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const suggestions = await listIntroSuggestions(req.params.mediaId);
    res.json({ suggestions });
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/ai/suggestions/:suggestionId/approve',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const { mediaId, suggestionId } = req.params;
    const sug = await getIntroSuggestion(suggestionId);
    if (!sug || sug.mediaId !== mediaId) {
      return res.status(404).json({ error: 'Suggestion not found.' });
    }

    await saveIntroSuggestion({ ...sug, status: 'approved', updatedAt: new Date().toISOString() });
    const updatedMedia = await updateMediaItem(mediaId, {
      introStart: sug.introStart,
      introEnd: sug.introEnd,
      outroStart: sug.outroStart,
      outroEnd: sug.outroEnd,
      chapters: sug.chapters,
    });

    await recordAudit(req, 'ai.suggestion_approved', 'media', mediaId, { suggestionId });
    res.json({ success: true, media: updatedMedia });
  }
);

controlPlaneRouter.post(
  '/media/:mediaId/ai/suggestions/:suggestionId/reject',
  requireAuth(['admin', 'editor']),
  async (req: Request, res: Response) => {
    const { mediaId, suggestionId } = req.params;
    const sug = await getIntroSuggestion(suggestionId);
    if (!sug || sug.mediaId !== mediaId) {
      return res.status(404).json({ error: 'Suggestion not found.' });
    }
    await saveIntroSuggestion({ ...sug, status: 'rejected', updatedAt: new Date().toISOString() });
    res.json({ success: true });
  }
);

// ==================== PROCESSING QUEUE & WORKER MANAGEMENT ====================

controlPlaneRouter.get('/jobs', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const status = (req.query.status as any) || 'all';
  const limit = Number(req.query.limit || 50);
  const jobs = await queueManager.listJobs(status, limit);
  res.json({ jobs, driver: queueManager.getDriverName() });
});

controlPlaneRouter.post('/jobs/:jobId/cancel', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const job = await queueManager.cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await recordAudit(req, 'job.cancelled', 'processing_jobs', job.id);
  res.json({ success: true, job });
});

controlPlaneRouter.post('/jobs/:jobId/retry', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const job = await queueManager.retryJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  await recordAudit(req, 'job.retried', 'processing_jobs', job.id);
  res.json({ success: true, job });
});

controlPlaneRouter.post('/jobs/replay-dlq', requireAuth(['admin']), async (req: Request, res: Response) => {
  const dlq = await queueManager.listJobs('dead_letter', 100);
  for (const job of dlq) {
    await queueManager.retryJob(job.id);
  }
  await recordAudit(req, 'job.replay_dlq', 'processing_jobs', 'bulk', { replayed: dlq.length });
  res.json({ success: true, replayed: dlq.length });
});

// ==================== SECURITY, RBAC, API KEYS & AUDIT LOGS ====================

controlPlaneRouter.get('/security/admins', requireAuth(['admin']), async (_req: Request, res: Response) => {
  const admins = await listAdminUsers();
  res.json({ admins, bootstrapAdminEmail: APP_CONFIG.bootstrapAdminEmail });
});

controlPlaneRouter.post('/security/admins', requireAuth(['admin']), async (req: Request, res: Response) => {
  const { uid, email, role = 'editor', displayName } = req.body || {};
  if (!uid || !email) {
    return res.status(400).json({ error: 'Firebase UID and verified email are required.' });
  }
  const cleanRole = role === 'admin' ? 'admin' : 'editor';
  const now = new Date().toISOString();
  const record = {
    uid: String(uid).trim(),
    email: String(email).trim().toLowerCase(),
    role: cleanRole as 'admin' | 'editor',
    active: true,
    displayName: displayName ? String(displayName).trim() : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await saveAdminUser(record);
  await recordAudit(req, 'rbac.admin_saved', 'admins', record.uid, { email: record.email, role: cleanRole });
  res.json({ success: true, admin: record });
});

controlPlaneRouter.delete('/security/admins/:uid', requireAuth(['admin']), async (req: Request, res: Response) => {
  if (req.params.uid === req.authCtx?.uid) {
    return res.status(400).json({ error: 'You cannot revoke your own active administrator account.' });
  }
  await deleteAdminUser(req.params.uid);
  await recordAudit(req, 'rbac.admin_removed', 'admins', req.params.uid);
  res.json({ success: true });
});

controlPlaneRouter.get('/security/api-keys', requireAuth(['admin']), async (_req: Request, res: Response) => {
  const keys = await listApiKeys();
  // Never return keyHash to UI
  res.json({ keys: keys.map(({ keyHash: _h, ...rest }) => rest) });
});

controlPlaneRouter.post('/security/api-keys', requireAuth(['admin']), async (req: Request, res: Response) => {
  const { name, role = 'editor', scopes = ['media:read', 'media:write'] } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'API key name is required.' });
  }
  const rawSecret = `vf_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = sha256Hex(rawSecret);
  const keyId = `key_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id: keyId,
    name: String(name).trim().slice(0, 80),
    keyPrefix: rawSecret.slice(0, 14) + '...',
    keyHash,
    scopes: Array.isArray(scopes) ? scopes.map(String) : ['media:read'],
    role: (role === 'admin' || role === 'playback' ? role : 'editor') as 'admin' | 'editor' | 'playback',
    ownerUid: req.authCtx!.uid,
    createdAt: new Date().toISOString(),
  };

  await saveApiKeyRecord(record);
  await recordAudit(req, 'security.api_key_created', 'api_keys', keyId, { name: record.name, role: record.role });
  // Return plaintext key ONCE at creation time
  const { keyHash: _h, ...safeRecord } = record;
  res.json({ success: true, apiKey: safeRecord, plaintextKey: rawSecret });
});

controlPlaneRouter.delete('/security/api-keys/:id', requireAuth(['admin']), async (req: Request, res: Response) => {
  await revokeApiKey(req.params.id);
  await recordAudit(req, 'security.api_key_revoked', 'api_keys', req.params.id);
  res.json({ success: true });
});

controlPlaneRouter.get('/security/audit-logs', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const logs = await listAuditLogs(Number(req.query.limit || 60));
  res.json({ logs });
});

// Internal Cloud Tasks / PubSub worker execution hook (protected by shared internal secret header if deployed standalone)
controlPlaneRouter.post('/internal/worker/execute', async (req: Request, res: Response) => {
  const workerSecret = process.env.WORKER_SHARED_SECRET;
  if (workerSecret && req.headers['x-vidframe-worker-secret'] !== workerSecret) {
    return res.status(403).json({ error: 'Forbidden worker invocation' });
  }
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  queueManager.executeJobById(String(jobId)).catch((err) => console.error('[InternalWorker] Error:', err));
  res.json({ accepted: true, jobId });
});
