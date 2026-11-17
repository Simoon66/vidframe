import express, { Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { TelegramService } from './telegramService.ts';
import {
  getMediaItems,
  listMediaPaginated,
  findMediaBySha256,
  getMediaItem,
  saveMediaItem,
  updateMediaItem,
  deleteMediaItem,
  saveMediaVersion,
  incrementShardedView,
  getStorageConfig,
  getSeriesItems,
  getSeriesItem,
  saveSeriesItem,
  deleteSeriesItem,
  recordViewEvent,
  getAnalyticsEvents,
  getReports,
  saveReport,
  updateReportStatus,
  deleteReport,
  MediaRecord,
  MediaVersionRecord,
  SeriesRecord,
  AnalyticsEvent,
  ReportRecord,
} from './db.ts';
import { getFirebaseConfig } from './config.ts';
import { computeFileSha256 } from './crypto.ts';
import { requireAuth, attachOptionalAuth, recordAudit } from './middleware/auth.ts';
import { rateLimit } from './middleware/rateLimit.ts';
import { telemetryMiddleware } from './observability/telemetry.ts';
import { safeProbeMediaUrl, safeDownloadUrlToTempFile } from './security/ssrfGuard.ts';
import { verifySignedPlaybackToken, getCdnCacheHeaders } from './security/signedUrls.ts';
import { getStorageAdapter, sanitizeStorageConfigForClient } from './storage/storageRouter.ts';
import { probeMediaFull, applyWebVttOffset } from './workers/mediaPipeline.ts';
import { queueManager } from './queue/queueManager.ts';
import { listAvailableAiProviders } from './ai/externalProviders.ts';
import { cdnRouter } from './routes/cdnRoutes.ts';
import { controlPlaneRouter } from './routes/controlPlaneRoutes.ts';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '100mb' }));
apiRouter.use(express.urlencoded({ extended: true, limit: '100mb' }));
apiRouter.use(telemetryMiddleware);
apiRouter.use(attachOptionalAuth);

// Mount Control Plane & Signed HLS CDN routes
apiRouter.use(cdnRouter);
apiRouter.use(controlPlaneRouter);

// Start background worker loop for durable HLS / AI / chapter jobs
queueManager.startWorkerLoop();

// Setup multer upload directory and video cache directories
const uploadDir = path.resolve(process.cwd(), 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

export const streamCacheDir = path.resolve(process.cwd(), 'stream_cache');
if (!fs.existsSync(streamCacheDir)) {
  fs.mkdirSync(streamCacheDir, { recursive: true });
}

export const subtitlesDir = path.resolve(process.cwd(), 'public_subtitles');
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

// Automatic cache cleaner to prevent disk bloat during video streaming and conversions
export function pruneCacheDirectory(dirPath: string, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const now = Date.now();
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  } catch {}
}

// Initial cleanup and periodic scheduled cleanup
pruneCacheDirectory(uploadDir, 30 * 60 * 1000); // 30 min for upload fragments
pruneCacheDirectory(streamCacheDir, 2 * 60 * 60 * 1000); // 2 hours for stream cache
setInterval(() => {
  pruneCacheDirectory(uploadDir, 30 * 60 * 1000);
  pruneCacheDirectory(streamCacheDir, 2 * 60 * 60 * 1000);
}, 15 * 60 * 1000).unref();

const LANGUAGE_NAME_MAP: Record<string, string> = {
  hin: 'Hindi (हिंदी)',
  tam: 'Tamil (தமிழ்)',
  tel: 'Telugu (తెలుగు)',
  mal: 'Malayalam (മലയാളം)',
  ben: 'Bengali (বাংলা)',
  ban: 'Bengali (বাংলা)',
  eng: 'English',
  jpn: 'Japanese (日本語)',
  kor: 'Korean (한국어)',
  spa: 'Spanish (Español)',
  fra: 'French (Français)',
  ger: 'German (Deutsch)',
  deu: 'German (Deutsch)',
  ita: 'Italian (Italiano)',
  rus: 'Russian (Русский)',
  ara: 'Arabic (العربية)',
  chi: 'Chinese (中文)',
  zho: 'Chinese (中文)',
  und: 'Default',
};

// Probe video file to accurately detect all audio tracks & subtitle tracks with readable names
export function probeFileTracks(filePath: string, mediaId: string): { audioTracks: any[]; subtitleTracks: any[] } {
  try {
    const probe = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath]);
    if (probe.status !== 0 || !probe.stdout) {
      return { audioTracks: [], subtitleTracks: [] };
    }
    const data = JSON.parse(probe.stdout.toString());
    const streams: any[] = data.streams || [];

    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const audioTracks = audioStreams.map((s, idx) => {
      const lang = (s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase();
      const langTitle = LANGUAGE_NAME_MAP[lang] || (lang !== 'und' ? lang.toUpperCase() : 'Audio');
      const titleTag = s.tags?.title || s.tags?.TITLE || '';
      const displayTitle = titleTag || `${langTitle} Audio (${(s.codec_name || 'aac').toUpperCase()})`;
      return {
        index: idx,
        language: lang,
        title: displayTitle,
        codec: s.codec_name || 'aac',
        channels: s.channels || 2,
      };
    });

    const subStreams = streams.filter((s) => s.codec_type === 'subtitle');
    const subtitleTracks = subStreams.map((s, idx) => {
      const lang = (s.tags?.language || s.tags?.LANGUAGE || 'en').toLowerCase();
      const langTitle = LANGUAGE_NAME_MAP[lang] || lang.toUpperCase();
      const titleTag = s.tags?.title || s.tags?.TITLE || '';
      const displayTitle = titleTag || `${langTitle} Subtitles`;

      const vttFile = path.join(subtitlesDir, `sub_${mediaId}_${idx}.vtt`);
      if (!fs.existsSync(vttFile)) {
        try {
          spawnSync('ffmpeg', ['-y', '-i', filePath, '-map', `0:${s.index}`, '-c:s', 'webvtt', vttFile]);
        } catch {}
      }

      return {
        index: idx,
        language: lang,
        title: displayTitle,
        format: 'vtt',
        url: `/api/media/${mediaId}/subtitles/${idx}.vtt`,
      };
    });

    return { audioTracks, subtitleTracks };
  } catch (err) {
    console.warn('[Probe error]:', err);
    return { audioTracks: [], subtitleTracks: [] };
  }
}

// In-flight remux promises to prevent duplicate simultaneous ffmpeg runs
const activeRemuxPromises = new Map<string, Promise<string>>();

// Ensure MKV is converted to fragmented faststart MP4 for 100% smooth browser playback & seeking
export async function ensureRemuxedMp4(media: MediaRecord, audioIndex: number): Promise<string> {
  const mp4Key = `${media.id}_a${audioIndex}`;
  const mp4Path = path.join(streamCacheDir, `${mp4Key}.mp4`);

  if (fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 1024) {
    return mp4Path;
  }

  if (activeRemuxPromises.has(mp4Key)) {
    return activeRemuxPromises.get(mp4Key)!;
  }

  const promise = (async () => {
    try {
      const rawPath = path.join(streamCacheDir, `raw_${media.id}.mkv`);
      if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
        console.log(`[Stream Transmux] Downloading raw MKV for ${media.id} from Telegram cloud...`);
        const client = await telegramService.ensureConnected();
        const bigInt = (await import('big-integer')).default;

        const fileStream = fs.createWriteStream(rawPath);
        const msgIds = (media.telegramMessageIds && media.telegramMessageIds.length > 0)
          ? media.telegramMessageIds
          : [media.telegramMessageId];

        for (const mId of msgIds) {
          const message = await telegramService.getMessageMedia(media.telegramChatId, mId);
          for await (const chunk of client.iterDownload({
            file: message.media,
            offset: bigInt(0) as any,
            requestSize: 1024 * 1024,
          })) {
            fileStream.write(chunk);
          }
        }
        await new Promise((resolve) => fileStream.end(resolve));
        console.log(`[Stream Transmux] Raw MKV download completed (${fs.statSync(rawPath).size} bytes).`);
      }

      if (!media.audioTracks || media.audioTracks.length === 0) {
        const { audioTracks, subtitleTracks } = probeFileTracks(rawPath, media.id);
        if (audioTracks.length > 0) {
          updateMediaItem(media.id, { audioTracks, subtitleTracks }).catch(() => {});
        }
      }

      console.log(`[Stream Transmux] Remuxing MKV ${media.id} (Audio Track ${audioIndex}) to streamable MP4...`);
      const tempOut = path.join(streamCacheDir, `${mp4Key}_temp.mp4`);

      // Attempt 1: Ultra-fast stream copy (video copy + audio aac)
      let ffmpegRes = spawnSync('ffmpeg', [
        '-y',
        '-i', rawPath,
        '-map', '0:v:0',
        '-map', `0:a:${audioIndex}?`,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        tempOut,
      ]);

      // Attempt 2: If video stream copy failed (e.g. non-MP4 compatible codec like HEVC/VP9 in browser MP4), transcode video to h264
      if (ffmpegRes.status !== 0 || !fs.existsSync(tempOut) || fs.statSync(tempOut).size === 0) {
        console.warn('[Stream Transmux Warning] Copy failed, attempting fallback H.264 transcode:', ffmpegRes.stderr?.toString());
        ffmpegRes = spawnSync('ffmpeg', [
          '-y',
          '-i', rawPath,
          '-map', '0:v:0',
          '-map', `0:a:${audioIndex}?`,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          tempOut,
        ]);
      }

      if (ffmpegRes.status !== 0 || !fs.existsSync(tempOut) || fs.statSync(tempOut).size === 0) {
        console.error('[Stream Transmux Error]:', ffmpegRes.stderr?.toString());
        throw new Error('Failed to remux MKV into streamable MP4');
      }

      try {
        fs.renameSync(tempOut, mp4Path);
      } catch {
        fs.copyFileSync(tempOut, mp4Path);
        try { fs.unlinkSync(tempOut); } catch {}
      }

      return mp4Path;
    } finally {
      activeRemuxPromises.delete(mp4Key);
    }
  })();

  activeRemuxPromises.set(mp4Key, promise);
  return promise;
}

// Immediate post-upload helper: registers master version v1, caches raw source locally if needed, and queues HLS packaging
async function stageUploadVersionAndQueueHls(
  filePath: string,
  media: MediaRecord,
  createdBy: string,
  preferredBackend?: 'telegram' | 's3_r2' | 'local_dev'
): Promise<void> {
  try {
    const versionId = `ver_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const objectPrefix = `media/${media.id}/${versionId}`;
    const sha256Hash = fs.existsSync(filePath) ? await computeFileSha256(filePath) : media.sha256Hash || '';
    let probe: ReturnType<typeof probeMediaFull> | null = null;
    try {
      probe = probeMediaFull(filePath);
    } catch {}

    const backend = preferredBackend || media.storageBackend || 'telegram';

    if (backend === 'telegram') {
      // Cache raw locally when MKV or multi-track so stream & worker immediately have source
      const streamSourcePath = path.join(streamCacheDir, `source_${media.id}_${versionId}.mkv`);
      if (fs.existsSync(filePath) && !fs.existsSync(streamSourcePath)) {
        fs.copyFileSync(filePath, streamSourcePath);
      }
      const isMkv =
        (media.mimeType && (media.mimeType.toLowerCase().includes('matroska') || media.mimeType.toLowerCase().includes('mkv'))) ||
        (media.filename && media.filename.toLowerCase().endsWith('.mkv'));
      if (isMkv) {
        const rawPath = path.join(streamCacheDir, `raw_${media.id}.mkv`);
        if (fs.existsSync(filePath) && (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0)) {
          fs.copyFileSync(filePath, rawPath);
        }
        const { audioTracks, subtitleTracks } = probeFileTracks(rawPath, media.id);
        if (audioTracks.length > 0 || subtitleTracks.length > 0) {
          media.audioTracks = audioTracks;
          media.subtitleTracks = subtitleTracks;
          await updateMediaItem(media.id, { audioTracks, subtitleTracks });
        }
        ensureRemuxedMp4(media, 0).catch((err) => console.warn('[Background Remux Notice]:', err));
      }
    }

    const now = new Date().toISOString();
    const versionRecord: MediaVersionRecord = {
      id: versionId,
      mediaId: media.id,
      versionNumber: 1,
      label: 'v1 Initial Master',
      filename: media.filename,
      mimeType: media.mimeType,
      size: media.size,
      duration: probe?.duration || media.duration || 0,
      sha256Hash,
      storageBackend: backend,
      objectPrefix,
      renditions: [],
      probeMetadata: probe
        ? {
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec,
            bitrate: probe.bitrate,
          }
        : undefined,
      audioTracks: probe?.audioTracks || media.audioTracks,
      telegramChatId: media.telegramChatId || undefined,
      telegramMessageId: media.telegramMessageId || undefined,
      telegramMessageIds: media.telegramMessageIds,
      status: 'queued',
      createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await saveMediaVersion(versionRecord);
    await updateMediaItem(media.id, {
      activeVersionId: versionId,
      sha256Hash: sha256Hash || undefined,
      duration: versionRecord.duration,
      storageBackend: backend,
      processingStatus: 'processing',
    });

    await queueManager.enqueue({
      idempotencyKey: `hls_${media.id}_${versionId}`,
      mediaId: media.id,
      versionId,
      jobType: 'transcode_hls',
      priority: 8,
      createdBy,
    });
  } catch (err) {
    console.warn('[stageUploadVersionAndQueueHls Notice]:', err);
  }
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 10000 * 1024 * 1024, // 10GB limit to support huge MKV / MP4 files
  },
});

const telegramService = TelegramService.getInstance();
telegramService.init().catch((e) => console.error('Telegram init error:', e));

// Helper: Stream a chunk of a file without keeping the whole 2GB in heap memory
function streamFileChunk(sourcePath: string, destPath: string, start: number, end: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(sourcePath, { start, end: end - 1, highWaterMark: 16 * 1024 * 1024 });
    const writeStream = fs.createWriteStream(destPath);
    readStream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    readStream.on('error', reject);
  });
}

// User-Agent and Geo Parser for Real Analytics
function parseUserAgent(ua: string): { device: 'Mobile' | 'Desktop' | 'Tablet' | 'Other'; os: 'Windows' | 'Android' | 'iOS' | 'macOS' | 'Linux' | 'Other'; browser: string } {
  let device: 'Mobile' | 'Desktop' | 'Tablet' | 'Other' = 'Desktop';
  let os: 'Windows' | 'Android' | 'iOS' | 'macOS' | 'Linux' | 'Other' = 'Other';
  let browser = 'Unknown';

  if (/tablet|ipad|playbook|silk/i.test(ua)) {
    device = 'Tablet';
  } else if (/mobile|iphone|ipod|android.*mobile|blackberry|iemobile/i.test(ua)) {
    device = 'Mobile';
  }

  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';
  else if (/edg/i.test(ua)) browser = 'Edge';

  return { device, os, browser };
}

function getCountryFromReq(req: Request): string {
  const c = (req.headers['cf-ipcountry'] || req.headers['x-country-code'] || req.headers['x-appengine-country'] || '') as string;
  if (c && c.length === 2) {
    const codeMap: Record<string, string> = {
      BD: 'Bangladesh',
      US: 'United States',
      IN: 'India',
      GB: 'United Kingdom',
      CA: 'Canada',
      DE: 'Germany',
      FR: 'France',
      JP: 'Japan',
      SG: 'Singapore',
      MY: 'Malaysia',
      PK: 'Pakistan',
      AE: 'United Arab Emirates',
      SA: 'Saudi Arabia',
      BR: 'Brazil',
      AU: 'Australia',
    };
    return codeMap[c.toUpperCase()] || c.toUpperCase();
  }
  return 'Bangladesh';
}

// 1. Overall System Status (Authenticated Only - Never expose email or secrets unauthenticated)
apiRouter.get('/status', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const tgState = telegramService.getState();
  const storage = await getStorageConfig();
  const cfg = getFirebaseConfig();
  const appUrl = process.env.APP_URL || '';

  res.json({
    telegram: tgState,
    storage: sanitizeStorageConfigForClient(storage),
    appUrl,
    adminEmail: req.authCtx?.email || '',
    role: req.authCtx?.role || 'editor',
    firestoreDatabaseId: cfg.firestoreDatabaseId,
    queueDriver: queueManager.getDriverName(),
    aiProviders: listAvailableAiProviders(),
  });
});

// 2. Save Telegram Credentials
apiRouter.post('/telegram/credentials', requireAuth(['admin']), rateLimit('auth'), async (req: Request, res: Response) => {
  const { apiId, apiHash } = req.body;
  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'Both apiId and apiHash are required.' });
  }

  const parsedId = Number(apiId);
  if (isNaN(parsedId) || parsedId <= 0) {
    return res.status(400).json({ error: 'apiId must be a valid positive integer.' });
  }

  telegramService.saveCredentials(parsedId, String(apiHash).trim());
  telegramService.init().catch(() => {});
  await recordAudit(req, 'telegram.credentials_saved', 'settings', 'telegram');

  res.json({ success: true, message: 'Telegram credentials saved successfully.' });
});

// 3. Telegram Login: Send Code
apiRouter.post('/telegram/send-code', requireAuth(['admin']), rateLimit('auth'), async (req: Request, res: Response) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  try {
    const result = await telegramService.sendCode(phoneNumber);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to send login code' });
  }
});

// 4. Telegram Login: Verify Code
apiRouter.post('/telegram/verify-code', requireAuth(['admin']), rateLimit('auth'), async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Verification code is required.' });
  }

  try {
    const result = await telegramService.verifyCode(code);
    await recordAudit(req, 'telegram.login_verified', 'settings', 'telegram');
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Verification failed' });
  }
});

// 5. Telegram Login: Verify 2FA
apiRouter.post('/telegram/verify-2fa', requireAuth(['admin']), rateLimit('auth'), async (req: Request, res: Response) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: '2FA password is required.' });
  }

  try {
    const result = await telegramService.verify2FAPassword(password);
    await recordAudit(req, 'telegram.2fa_verified', 'settings', 'telegram');
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || '2FA verification failed' });
  }
});

// 6. Telegram Disconnect
apiRouter.post('/telegram/disconnect', requireAuth(['admin']), async (req: Request, res: Response) => {
  try {
    await telegramService.disconnect();
    await recordAudit(req, 'telegram.disconnected', 'settings', 'telegram');
    res.json({ success: true, message: 'Telegram session cleared.' });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to disconnect.' });
  }
});

// 6b. Telegram Explicit Reconnect & Health Check
apiRouter.post('/telegram/reconnect', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    await telegramService.reconnect();
    await recordAudit(req, 'telegram.reconnected', 'settings', 'telegram');
    res.json({
      success: true,
      message: 'Telegram MTProto client reconnected successfully.',
      state: telegramService.getState(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: error?.message || 'Failed to reconnect Telegram MTProto client.',
      state: telegramService.getState(),
    });
  }
});

// 7. Storage Config (Sanitized)
apiRouter.get('/storage/config', requireAuth(['admin', 'editor']), async (_req: Request, res: Response) => {
  const config = await getStorageConfig();
  res.json(sanitizeStorageConfigForClient(config));
});

apiRouter.post('/storage/test', requireAuth(['admin']), async (req: Request, res: Response) => {
  const { chatId } = req.body;
  if (!chatId) {
    return res.status(400).json({ error: 'Chat ID or username is required.' });
  }

  try {
    const verified = await telegramService.testStorage(String(chatId).trim());
    await recordAudit(req, 'storage.telegram_tested', 'settings', 'storage', { chatId: verified.chatId });
    res.json({ success: true, storage: sanitizeStorageConfigForClient(verified) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Storage verification failed' });
  }
});

// 9. Media Library: List (Supports cursor pagination when ?paginated=true)
apiRouter.get('/media', requireAuth(['admin', 'editor', 'api_key']), async (req: Request, res: Response) => {
  try {
    const usePaginated = req.query.paginated === 'true';
    if (usePaginated) {
      const result = await listMediaPaginated({
        limit: Number(req.query.limit || 24),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        visibility: typeof req.query.visibility === 'string' ? req.query.visibility : undefined,
        folder: typeof req.query.folder === 'string' ? req.query.folder : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      });
      return res.json(result);
    }
    const items = await getMediaItems();
    res.json(items);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to retrieve media library' });
  }
});

// 10. Media Library: Upload (Supports Pluggable S3/R2/Local/Telegram + SHA-256 Duplicate Warning + Async HLS Packaging)
apiRouter.post(
  '/media/upload',
  requireAuth(['admin', 'editor']),
  rateLimit('upload'),
  upload.single('video'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided.' });
    }

    const tempFilePath = req.file.path;
    const originalName = req.file.originalname;
    const mimeType = req.file.mimetype || (originalName.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4');
    const fileSize = req.file.size;
    const title = (req.body.title || originalName.replace(/\.[^/.]+$/, '')).trim();
    const description = (req.body.description || '').trim();
    const visibility = ['public', 'unlisted', 'private'].includes(req.body.visibility)
      ? req.body.visibility
      : 'public';

    const introStart = Number(req.body.introStart) || 0;
    const introEnd = Number(req.body.introEnd) || 0;
    const outroStart = Number(req.body.outroStart) || 0;
    const outroEnd = Number(req.body.outroEnd) || 0;

    try {
      const sha256Hash = await computeFileSha256(tempFilePath);
      const duplicateMatch = await findMediaBySha256(sha256Hash).catch(() => null);
      const adapter = await getStorageAdapter();
      const mediaId = crypto.randomBytes(8).toString('hex');

      const messageIds: number[] = [];
      let mainChatId = '';
      let totalUploadedSize = fileSize;
      let finalDuration = 0;

      if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
        const ext = path.extname(originalName) || '.mp4';
        const tempVerId = `ver_init_${mediaId}`;
        await adapter.putFile(`media/${mediaId}/${tempVerId}/master_source${ext}`, tempFilePath, mimeType);
      } else {
        const MAX_CHUNK = 1.9 * 1024 * 1024 * 1024;
        if (fileSize > MAX_CHUNK) {
          let offset = 0;
          let partIndex = 1;
          totalUploadedSize = 0;
          while (offset < fileSize) {
            const currentChunkSize = Math.min(MAX_CHUNK, fileSize - offset);
            const chunkPath = path.join(uploadDir, `part_${Date.now()}_${partIndex}_${originalName}`);
            await streamFileChunk(tempFilePath, chunkPath, offset, offset + currentChunkSize);
            const partCaption = `VidFrame [Part ${partIndex}]: ${title} (${originalName})`;
            const uploadRes = await telegramService.uploadVideo(
              chunkPath,
              `${originalName}.part${partIndex}`,
              mimeType,
              partCaption
            );
            messageIds.push(uploadRes.messageId);
            mainChatId = uploadRes.chatId;
            totalUploadedSize += uploadRes.size;
            if (uploadRes.duration && uploadRes.duration > finalDuration) {
              finalDuration = uploadRes.duration;
            }
            if (fs.existsSync(chunkPath)) try { fs.unlinkSync(chunkPath); } catch {}
            offset += currentChunkSize;
            partIndex++;
          }
        } else {
          const uploadResult = await telegramService.uploadVideo(
            tempFilePath,
            originalName,
            mimeType,
            `VidFrame: ${title}`
          );
          messageIds.push(uploadResult.messageId);
          mainChatId = uploadResult.chatId;
          totalUploadedSize = uploadResult.size || fileSize;
          finalDuration = uploadResult.duration || 0;
        }
      }

      const newMedia: MediaRecord = {
        id: mediaId,
        title,
        description: description || (originalName.endsWith('.mkv') ? 'MKV Container (Audio & Subtitles detected)' : ''),
        filename: originalName,
        mimeType,
        size: totalUploadedSize,
        duration: finalDuration,
        telegramChatId: mainChatId,
        telegramMessageId: messageIds[0] || 0,
        telegramMessageIds: messageIds,
        introStart,
        introEnd,
        outroStart,
        outroEnd,
        visibility,
        processingStatus: 'processing',
        playbackMode: 'legacy_telegram',
        storageBackend: adapter.mode,
        sha256Hash,
        ownerId: req.authCtx?.uid,
        views: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveMediaItem(newMedia);
      await stageUploadVersionAndQueueHls(tempFilePath, newMedia, req.authCtx!.uid, adapter.mode);
      if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
        const latest = await getMediaItem(mediaId);
        if (latest?.activeVersionId) {
          const ext = path.extname(originalName) || '.mp4';
          await adapter.putFile(`media/${mediaId}/${latest.activeVersionId}/master_source${ext}`, tempFilePath, mimeType);
        }
      }

      await recordAudit(req, 'media.uploaded', 'media', mediaId, {
        filename: originalName,
        size: totalUploadedSize,
        backend: adapter.mode,
      });

      res.json({
        success: true,
        media: (await getMediaItem(mediaId)) || newMedia,
        duplicateWarning: duplicateMatch ? { id: duplicateMatch.id, title: duplicateMatch.title } : null,
      });
    } catch (error: any) {
      console.error('Upload failed:', error);
      res.status(500).json({
        error: error?.message || 'Failed to upload video to storage backend.',
      });
    } finally {
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
      }
    }
  }
);

// Helper: Append a chunk to a destination write stream
function appendFileChunk(sourcePath: string, destStream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(sourcePath);
    readStream.pipe(destStream, { end: false });
    readStream.on('end', resolve);
    readStream.on('error', reject);
  });
}

// 10b. Chunked Upload: Receive a 2MB chunk with auth + multer error protection
apiRouter.post(
  '/media/upload-chunk',
  requireAuth(['admin', 'editor']),
  (req: Request, res: Response, next) => {
    upload.single('chunk')(req, res, (err) => {
      if (err) {
        console.error('[Upload Chunk Multer Error]:', err);
        return res.status(400).json({ error: err?.message || 'Chunk upload parse error' });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk file received' });
    }

    const { uploadId, chunkIndex, totalChunks } = req.body;
    if (!uploadId || chunkIndex === undefined) {
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'uploadId and chunkIndex are required' });
    }

    const targetChunkPath = path.join(uploadDir, `chunk_${uploadId}_${chunkIndex}`);
    try {
      if (fs.existsSync(targetChunkPath)) {
        try { fs.unlinkSync(targetChunkPath); } catch {}
      }
      try {
        fs.renameSync(req.file.path, targetChunkPath);
      } catch {
        fs.copyFileSync(req.file.path, targetChunkPath);
        try { fs.unlinkSync(req.file.path); } catch {}
      }
      res.json({ success: true, uploadId, chunkIndex: Number(chunkIndex), totalChunks: Number(totalChunks) });
    } catch (err: any) {
      if (fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: err?.message || 'Failed to save chunk' });
    }
  }
);

export interface UploadProgressRecord {
  stage: 'assembling' | 'uploading_telegram' | 'saving' | 'complete' | 'error';
  telegramPercent: number;
  overallPercent: number;
  statusText: string;
  result?: any;
  error?: string;
  updatedAt: number;
}

const activeUploadProgress = new Map<string, UploadProgressRecord>();

// Poll endpoint for real-time progress during server assemble and upload
apiRouter.get('/media/upload-progress/:uploadId', requireAuth(['admin', 'editor']), (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const progress = activeUploadProgress.get(uploadId);
  if (!progress) {
    return res.json({
      stage: 'waiting',
      telegramPercent: 0,
      overallPercent: 88,
      statusText: 'Preparing upload...',
    });
  }
  res.json(progress);
});

// 10c. Chunked Upload: Assemble chunks, upload master to active storage backend, create v1 version & enqueue HLS ABR packaging
apiRouter.post('/media/upload-finish', requireAuth(['admin', 'editor']), rateLimit('upload'), async (req: Request, res: Response) => {
  const {
    uploadId,
    totalChunks,
    originalName,
    mimeType: reqMimeType,
    title: reqTitle,
    description: reqDescription,
    visibility: reqVisibility,
    folder,
    introStart = 0,
    introEnd = 0,
    outroStart = 0,
    outroEnd = 0,
  } = req.body;

  if (!uploadId || !totalChunks || !originalName) {
    return res.status(400).json({ error: 'uploadId, totalChunks, and originalName are required.' });
  }

  activeUploadProgress.set(uploadId, {
    stage: 'assembling',
    telegramPercent: 0,
    overallPercent: 89,
    statusText: 'Assembling chunks on server...',
    updatedAt: Date.now(),
  });

  const total = Number(totalChunks);
  const assembledFilePath = path.join(uploadDir, `assembled_${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  if (fs.existsSync(assembledFilePath)) {
    try { fs.unlinkSync(assembledFilePath); } catch {}
  }
  let uploadFilePath = assembledFilePath;

  try {
    for (let i = 0; i < total; i++) {
      const chunkFile = path.join(uploadDir, `chunk_${uploadId}_${i}`);
      if (!fs.existsSync(chunkFile)) {
        throw new Error(`Missing chunk index ${i} of ${total}. Upload may have been interrupted.`);
      }
      const chunkBuffer = fs.readFileSync(chunkFile);
      fs.appendFileSync(assembledFilePath, chunkBuffer);
      try { fs.unlinkSync(chunkFile); } catch {}
    }

    uploadFilePath = assembledFilePath;
    let finalOriginalName = originalName;
    let finalMimeType = reqMimeType || (originalName.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4');

    const adapter = await getStorageAdapter();
    const sha256Hash = await computeFileSha256(assembledFilePath);
    const duplicateMatch = await findMediaBySha256(sha256Hash).catch(() => null);

    // If Telegram backend + MKV: faststart remux so direct MP4 fallback is instant while HLS worker packages full ABR ladder
    if (adapter.mode === 'telegram' && (finalOriginalName.toLowerCase().endsWith('.mkv') || finalMimeType.includes('matroska'))) {
      activeUploadProgress.set(uploadId, {
        stage: 'assembling',
        telegramPercent: 0,
        overallPercent: 90,
        statusText: 'Remuxing MKV into faststart MP4 container for instant streaming...',
        updatedAt: Date.now(),
      });

      const mp4ConvertedPath = path.join(uploadDir, `converted_${Date.now()}_${originalName.replace(/\.[^/.]+$/, '')}.mp4`);
      const remuxRes = spawnSync('ffmpeg', [
        '-y',
        '-i', assembledFilePath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        mp4ConvertedPath,
      ]);

      if (remuxRes.status === 0 && fs.existsSync(mp4ConvertedPath) && fs.statSync(mp4ConvertedPath).size > 1024) {
        uploadFilePath = mp4ConvertedPath;
        finalOriginalName = originalName.replace(/\.mkv$/i, '.mp4');
        finalMimeType = 'video/mp4';
      }
    }

    const currentStats = fs.statSync(uploadFilePath);
    const fileSize = currentStats.size;
    const title = (reqTitle || finalOriginalName.replace(/\.[^/.]+$/, '')).trim();
    const description = (reqDescription || '').trim();
    const mimeType = finalMimeType;
    const visibility = ['public', 'unlisted', 'private'].includes(reqVisibility) ? reqVisibility : 'public';

    const mediaId = crypto.randomBytes(8).toString('hex');
    const messageIds: number[] = [];
    let mainChatId = '';
    let totalUploadedSize = fileSize;
    let finalDuration = 0;

    if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
      activeUploadProgress.set(uploadId, {
        stage: 'uploading_telegram',
        telegramPercent: 40,
        overallPercent: 93,
        statusText: `Storing master source on ${adapter.mode}...`,
        updatedAt: Date.now(),
      });
    } else {
      activeUploadProgress.set(uploadId, {
        stage: 'uploading_telegram',
        telegramPercent: 0,
        overallPercent: 91,
        statusText: 'Starting Telegram cloud upload...',
        updatedAt: Date.now(),
      });

      const MAX_CHUNK = 1.9 * 1024 * 1024 * 1024;
      if (fileSize > MAX_CHUNK) {
        let offset = 0;
        let partIndex = 1;
        totalUploadedSize = 0;

        while (offset < fileSize) {
          const currentChunkSize = Math.min(MAX_CHUNK, fileSize - offset);
          const chunkPath = path.join(uploadDir, `part_${Date.now()}_${partIndex}_${finalOriginalName}`);
          await streamFileChunk(uploadFilePath, chunkPath, offset, offset + currentChunkSize);

          const partCaption = `VidFrame [Part ${partIndex}]: ${title} (${finalOriginalName})`;
          const uploadRes = await telegramService.uploadVideo(
            chunkPath,
            `${finalOriginalName}.part${partIndex}`,
            mimeType,
            partCaption,
            (partPercent) => {
              const overall = 91 + Math.min(8, Math.floor(((offset + (partPercent / 100) * currentChunkSize) / fileSize) * 8));
              activeUploadProgress.set(uploadId, {
                stage: 'uploading_telegram',
                telegramPercent: partPercent,
                overallPercent: overall,
                statusText: `Uploading Part ${partIndex}: ${partPercent}% to Telegram cloud...`,
                updatedAt: Date.now(),
              });
            }
          );

          messageIds.push(uploadRes.messageId);
          mainChatId = uploadRes.chatId;
          totalUploadedSize += uploadRes.size;
          if (uploadRes.duration && uploadRes.duration > finalDuration) {
            finalDuration = uploadRes.duration;
          }
          if (fs.existsSync(chunkPath)) try { fs.unlinkSync(chunkPath); } catch {}
          offset += currentChunkSize;
          partIndex++;
        }
      } else {
        const uploadResult = await telegramService.uploadVideo(
          uploadFilePath,
          finalOriginalName,
          mimeType,
          `VidFrame: ${title}`,
          (telegramPercent) => {
            const overall = 91 + Math.min(8, Math.floor((telegramPercent / 100) * 8));
            activeUploadProgress.set(uploadId, {
              stage: 'uploading_telegram',
              telegramPercent,
              overallPercent: overall,
              statusText: `Uploading to Telegram cloud: ${telegramPercent}%`,
              updatedAt: Date.now(),
            });
          }
        );
        messageIds.push(uploadResult.messageId);
        mainChatId = uploadResult.chatId;
        totalUploadedSize = uploadResult.size || fileSize;
        finalDuration = uploadResult.duration || 0;
      }
    }

    const newMedia: MediaRecord = {
      id: mediaId,
      title,
      description: description || (finalOriginalName.endsWith('.mkv') ? 'MKV Container (Audio & Subtitles detected)' : ''),
      filename: originalName,
      mimeType,
      size: totalUploadedSize,
      duration: finalDuration,
      telegramChatId: mainChatId,
      telegramMessageId: messageIds[0] || 0,
      telegramMessageIds: messageIds,
      introStart: Number(introStart) || 0,
      introEnd: Number(introEnd) || 0,
      outroStart: Number(outroStart) || 0,
      outroEnd: Number(outroEnd) || 0,
      visibility,
      folder: folder ? String(folder).trim() : undefined,
      processingStatus: 'processing',
      playbackMode: 'legacy_telegram',
      storageBackend: adapter.mode,
      sha256Hash,
      ownerId: req.authCtx?.uid,
      views: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveMediaItem(newMedia);
    await stageUploadVersionAndQueueHls(assembledFilePath, newMedia, req.authCtx!.uid, adapter.mode);
    if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
      const latest = await getMediaItem(mediaId);
      if (latest?.activeVersionId) {
        const ext = path.extname(originalName) || '.mp4';
        await adapter.putFile(`media/${mediaId}/${latest.activeVersionId}/master_source${ext}`, assembledFilePath, mimeType);
      }
    }

    await recordAudit(req, 'media.uploaded_chunked', 'media', mediaId, {
      filename: originalName,
      size: totalUploadedSize,
      backend: adapter.mode,
    });

    const savedMedia = (await getMediaItem(mediaId)) || newMedia;
    const responsePayload = {
      success: true,
      media: savedMedia,
      duplicateWarning: duplicateMatch ? { id: duplicateMatch.id, title: duplicateMatch.title } : null,
    };
    activeUploadProgress.set(uploadId, {
      stage: 'complete',
      telegramPercent: 100,
      overallPercent: 100,
      statusText: 'Upload complete! HLS packaging queued.',
      result: responsePayload,
      updatedAt: Date.now(),
    });

    res.json(responsePayload);
  } catch (error: any) {
    console.error('Chunked upload finish error:', error);
    activeUploadProgress.set(uploadId, {
      stage: 'error',
      telegramPercent: 0,
      overallPercent: 0,
      statusText: error?.message || 'Failed to assemble and upload video',
      error: error?.message || 'Failed to assemble and upload video',
      updatedAt: Date.now(),
    });
    res.status(500).json({ error: error?.message || 'Failed to assemble and upload video' });
  } finally {
    if (fs.existsSync(assembledFilePath)) {
      try { fs.unlinkSync(assembledFilePath); } catch {}
    }
    if (typeof uploadFilePath !== 'undefined' && uploadFilePath !== assembledFilePath && fs.existsSync(uploadFilePath)) {
      try { fs.unlinkSync(uploadFilePath); } catch {}
    }
  }
});

// 11. Media Library: Get single & register view event (enforces private check)
apiRouter.get('/media/:mediaId', async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const item = await getMediaItem(mediaId);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (item.visibility === 'private' && !req.authCtx) {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const check = token && item.activeVersionId ? verifySignedPlaybackToken(token, mediaId, item.activeVersionId) : { valid: false };
    if (!check.valid) {
      return res.status(403).json({ error: 'Authentication or valid signed token required for private media.' });
    }
  }

  // Record real view event + write-sharded view counter
  const ua = req.headers['user-agent'] || '';
  const parsedUA = parseUserAgent(ua);
  const country = getCountryFromReq(req);

  const event: AnalyticsEvent = {
    id: `view_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    mediaId: item.id,
    mediaTitle: item.title,
    timestamp: new Date().toISOString(),
    country,
    device: parsedUA.device,
    os: parsedUA.os,
    browser: parsedUA.browser,
  };

  recordViewEvent(event).catch(() => {});
  incrementShardedView(mediaId).catch(() => {});

  res.json(item);
});

// 12. Media Library: Update metadata
apiRouter.put('/media/:mediaId', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const updates = req.body;

  try {
    const updated = await updateMediaItem(mediaId, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Media not found' });
    }
    await recordAudit(req, 'media.updated', 'media', mediaId);
    res.json({ success: true, media: updated });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update media item' });
  }
});

// 13. Media Library: Delete
apiRouter.delete('/media/:mediaId', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  try {
    await deleteMediaItem(mediaId);
    await recordAudit(req, 'media.deleted', 'media', mediaId);
    res.json({ success: true, message: 'Media removed.' });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete media.' });
  }
});

// Batch Delete & Move
apiRouter.post('/media/batch-delete', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No media IDs provided.' });
  }
  try {
    for (const id of ids) {
      await deleteMediaItem(id);
    }
    await recordAudit(req, 'media.batch_deleted', 'media', 'bulk', { count: ids.length });
    res.json({ success: true, count: ids.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed batch delete.' });
  }
});

apiRouter.post('/media/batch-folder', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { ids, folder } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No media IDs provided.' });
  }
  try {
    for (const id of ids) {
      await updateMediaItem(id, { folder: folder || '' });
    }
    await recordAudit(req, 'media.batch_moved', 'media', 'bulk', { count: ids.length, folder: folder || '' });
    res.json({ success: true, count: ids.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed batch folder update.' });
  }
});

// SSRF-Hardened Check URL(s) to verify link safety, DNS pinning, content-type, and file size
apiRouter.post('/media/check-url', requireAuth(['admin', 'editor']), rateLimit('urlImport'), async (req: Request, res: Response) => {
  const rawUrls: string[] = Array.isArray(req.body.urls)
    ? req.body.urls
    : req.body.url
    ? [req.body.url]
    : [];

  if (rawUrls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided to check.' });
  }

  const checks = await Promise.all(
    rawUrls.map(async (raw) => {
      const url = String(raw).trim();
      if (!url) return null;
      return safeProbeMediaUrl(url);
    })
  );

  res.json({ success: true, checks: checks.filter(Boolean) });
});

// Single SSRF-Hardened URL upload endpoint
apiRouter.post('/media/upload-url', requireAuth(['admin', 'editor']), rateLimit('urlImport'), async (req: Request, res: Response) => {
  const { url, title: userTitle, description: userDesc, visibility = 'public', folder = '' } = req.body;
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'Video download URL is required.' });
  }

  const cleanUrl = String(url).trim();
  const tempFilePath = path.join(uploadDir, `url_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

  try {
    const downloaded = await safeDownloadUrlToTempFile(cleanUrl, tempFilePath);
    const title = (userTitle || downloaded.fileName.replace(/\.[^/.]+$/, '')).trim();
    const sha256Hash = await computeFileSha256(tempFilePath);
    const duplicateMatch = await findMediaBySha256(sha256Hash).catch(() => null);
    const adapter = await getStorageAdapter();
    const mediaId = crypto.randomBytes(8).toString('hex');

    let telegramChatId = '';
    let telegramMessageId = 0;
    let totalSize = downloaded.size;
    let duration = 0;

    if (adapter.mode === 'telegram') {
      const uploadResult = await telegramService.uploadVideo(
        tempFilePath,
        downloaded.fileName,
        downloaded.mimeType,
        `VidFrame: ${title}`
      );
      telegramChatId = uploadResult.chatId;
      telegramMessageId = uploadResult.messageId;
      totalSize = uploadResult.size || downloaded.size;
      duration = uploadResult.duration || 0;
    }

    const newMedia: MediaRecord = {
      id: mediaId,
      title,
      description: (userDesc || '').trim() || (downloaded.fileName.endsWith('.mkv') ? 'MKV Container' : ''),
      filename: downloaded.fileName,
      mimeType: downloaded.mimeType,
      size: totalSize,
      duration,
      telegramChatId,
      telegramMessageId,
      visibility: ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'public',
      folder: folder ? String(folder).trim() : undefined,
      processingStatus: 'processing',
      playbackMode: 'legacy_telegram',
      storageBackend: adapter.mode,
      sha256Hash,
      ownerId: req.authCtx?.uid,
      views: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveMediaItem(newMedia);
    await stageUploadVersionAndQueueHls(tempFilePath, newMedia, req.authCtx!.uid, adapter.mode);
    if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
      const latest = await getMediaItem(mediaId);
      if (latest?.activeVersionId) {
        const ext = path.extname(downloaded.fileName) || '.mp4';
        await adapter.putFile(`media/${mediaId}/${latest.activeVersionId}/master_source${ext}`, tempFilePath, downloaded.mimeType);
      }
    }

    await recordAudit(req, 'media.url_imported', 'media', mediaId, { sourceUrl: cleanUrl, backend: adapter.mode });
    res.json({
      success: true,
      media: (await getMediaItem(mediaId)) || newMedia,
      duplicateWarning: duplicateMatch ? { id: duplicateMatch.id, title: duplicateMatch.title } : null,
    });
  } catch (err: any) {
    console.error('URL upload failed:', err);
    res.status(400).json({ error: err.message || 'Failed to download and upload video from URL.' });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  }
});

// Bulk SSRF-Hardened URL upload endpoint
apiRouter.post('/media/bulk-upload-urls', requireAuth(['admin', 'editor']), rateLimit('urlImport'), async (req: Request, res: Response) => {
  const { urls, visibility = 'public', folder = '' } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided.' });
  }

  const results: MediaRecord[] = [];
  const errors: string[] = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl).trim();
    if (!url) continue;

    const tempFilePath = path.join(uploadDir, `bulk_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);
    try {
      const downloaded = await safeDownloadUrlToTempFile(url, tempFilePath);
      const videoTitle = downloaded.fileName.replace(/\.[^/.]+$/, '');
      const sha256Hash = await computeFileSha256(tempFilePath);
      const adapter = await getStorageAdapter();
      const mediaId = crypto.randomBytes(8).toString('hex');

      let telegramChatId = '';
      let telegramMessageId = 0;
      let totalSize = downloaded.size;
      let duration = 0;

      if (adapter.mode === 'telegram') {
        const uploadResult = await telegramService.uploadVideo(
          tempFilePath,
          downloaded.fileName,
          downloaded.mimeType,
          `VidFrame: ${videoTitle}`
        );
        telegramChatId = uploadResult.chatId;
        telegramMessageId = uploadResult.messageId;
        totalSize = uploadResult.size || downloaded.size;
        duration = uploadResult.duration || 0;
      }

      const newMedia: MediaRecord = {
        id: mediaId,
        title: videoTitle,
        description: downloaded.fileName.endsWith('.mkv') ? 'MKV Container' : 'Imported via URL',
        filename: downloaded.fileName,
        mimeType: downloaded.mimeType,
        size: totalSize,
        duration,
        telegramChatId,
        telegramMessageId,
        visibility: ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'public',
        folder: folder ? String(folder).trim() : undefined,
        processingStatus: 'processing',
        playbackMode: 'legacy_telegram',
        storageBackend: adapter.mode,
        sha256Hash,
        ownerId: req.authCtx?.uid,
        views: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveMediaItem(newMedia);
      await stageUploadVersionAndQueueHls(tempFilePath, newMedia, req.authCtx!.uid, adapter.mode);
      if (adapter.mode === 's3_r2' || adapter.mode === 'local_dev') {
        const latest = await getMediaItem(mediaId);
        if (latest?.activeVersionId) {
          const ext = path.extname(downloaded.fileName) || '.mp4';
          await adapter.putFile(`media/${mediaId}/${latest.activeVersionId}/master_source${ext}`, tempFilePath, downloaded.mimeType);
        }
      }
      results.push((await getMediaItem(mediaId)) || newMedia);
    } catch (err: any) {
      errors.push(`${url}: ${err.message}`);
    } finally {
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
      }
    }
  }

  await recordAudit(req, 'media.bulk_url_imported', 'media', 'bulk', { count: results.length, errorCount: errors.length });
  res.json({ success: true, media: results, errors });
});

// Stream media file with range requests (Status 206) and private token enforcement
apiRouter.get('/media/:mediaId/stream', async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const media = await getMediaItem(mediaId);

  if (!media) {
    return res.status(404).send('Media not found');
  }

  if (media.visibility === 'private' && !req.authCtx) {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const check = token && media.activeVersionId ? verifySignedPlaybackToken(token, mediaId, media.activeVersionId) : { valid: false };
    if (!check.valid) {
      return res.status(403).json({ error: 'Private media requires authorization or a valid signed token.' });
    }
  }

  res.setHeader('Cache-Control', getCdnCacheHeaders(media.visibility, false));
  res.setHeader('Vary', 'Authorization, Origin');

  const isMkv =
    (media.mimeType && media.mimeType.toLowerCase().includes('matroska')) ||
    (media.filename && media.filename.toLowerCase().endsWith('.mkv'));

  const audioIndex = parseInt((req.query.audio as string) || '0', 10);

  // If MKV: Always serve from remuxed MP4 for 100% HTML5 browser playback, seeking, and multi-audio support
  if (isMkv) {
    try {
      const mp4Path = await ensureRemuxedMp4(media, audioIndex);
      const stat = fs.statSync(mp4Path);
      const totalSize = stat.size;

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        let start = 0;
        let end = totalSize - 1;
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          start = parseInt(match[1], 10);
          if (match[2]) {
            end = parseInt(match[2], 10);
          }
        }

        if (start >= totalSize || end >= totalSize || start > end) {
          res.setHeader('Content-Range', `bytes */${totalSize}`);
          return res.status(416).send('Requested Range Not Satisfiable');
        }

        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        if (req.method === 'HEAD') return res.end();
        const readStream = fs.createReadStream(mp4Path, { start, end });
        return readStream.pipe(res);
      } else {
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', totalSize);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(mp4Path).pipe(res);
      }
    } catch (err: any) {
      console.error(`MKV Transmux Stream Error for ${mediaId}:`, err);
      return res.status(500).json({ error: err.message || 'Failed to stream MKV file' });
    }
  }

  try {
    const messageIdToStream = media.telegramMessageId;
    const message = await telegramService.getMessageMedia(media.telegramChatId, messageIdToStream);
    const mediaDoc = (message.media as any)?.document;
    const totalSize = mediaDoc?.size ? Number(mediaDoc.size) : media.size;
    const contentType = media.mimeType || 'video/mp4';

    const rangeHeader = req.headers.range;
    let start = 0;
    let end = totalSize - 1;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        }
      }

      if (start >= totalSize || end >= totalSize || start > end) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).send('Requested Range Not Satisfiable');
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', totalSize);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    if (req.method === 'HEAD') {
      return res.end();
    }

    let isAborted = false;
    req.on('close', () => {
      isAborted = true;
    });

    try {
      const client = await telegramService.ensureConnected();
      const bigInt = (await import('big-integer')).default;
      const downloadIterator = client.iterDownload({
        file: message.media,
        offset: bigInt(start) as any,
        requestSize: 256 * 1024, // 256KB segments for responsive progressive playback
      });

      let bytesSent = 0;
      const requestedLength = end - start + 1;

      for await (const chunk of downloadIterator) {
        if (isAborted) break;

        const bytesToSend = Math.min(chunk.length, requestedLength - bytesSent);
        const bufferToSend = bytesToSend < chunk.length ? chunk.subarray(0, bytesToSend) : chunk;

        if (!res.write(bufferToSend)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }

        bytesSent += bufferToSend.length;
        if (bytesSent >= requestedLength) {
          break;
        }
      }
      res.end();
    } catch (streamError) {
      if (!isAborted) {
        console.warn('Streaming notice:', streamError);
      }
    }
  } catch (error: any) {
    console.error(`Stream error for media ${mediaId}:`, error);
    res.status(503).json({
      error: 'Telegram streaming unavailable',
      details: error?.message || 'Storage client connection required',
    });
  }
});

// Fetch Audio & Subtitle Tracks for any media (MKV or MP4)
apiRouter.get('/media/:mediaId/tracks', async (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const media = await getMediaItem(mediaId);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  // If already stored in database record, return immediately
  if (media.audioTracks && media.audioTracks.length > 0 && media.subtitleTracks) {
    return res.json({
      audioTracks: media.audioTracks,
      subtitleTracks: media.subtitleTracks,
    });
  }

  // Check if raw or mp4 is in stream cache first
  const rawCacheFile = path.join(streamCacheDir, `raw_${media.id}.mkv`);
  const anyMp4 = path.join(streamCacheDir, `${media.id}_a0.mp4`);
  const localFile = fs.existsSync(rawCacheFile) ? rawCacheFile : (fs.existsSync(anyMp4) ? anyMp4 : '');

  if (localFile) {
    const { audioTracks, subtitleTracks } = probeFileTracks(localFile, media.id);
    if (audioTracks.length > 0) {
      updateMediaItem(media.id, { audioTracks, subtitleTracks }).catch(() => {});
      return res.json({ audioTracks, subtitleTracks });
    }
  }

  // Probe media headers using first 4MB from Telegram
  try {
    const client = await telegramService.ensureConnected();
    const message = await telegramService.getMessageMedia(media.telegramChatId, media.telegramMessageId);
    const bigInt = (await import('big-integer')).default;

    const chunks: Buffer[] = [];
    let bytesCollected = 0;
    const probeLimit = 4 * 1024 * 1024; // 4MB is sufficient for MKV headers

    for await (const chunk of client.iterDownload({
      file: message.media,
      offset: bigInt(0) as any,
      requestSize: 512 * 1024,
    })) {
      chunks.push(chunk as Buffer);
      bytesCollected += chunk.length;
      if (bytesCollected >= probeLimit) break;
    }

    const tempProbePath = path.join(uploadDir, `probe_${media.id}.tmp`);
    fs.writeFileSync(tempProbePath, Buffer.concat(chunks));

    const probeRes = spawnSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      tempProbePath,
    ]);

    try { fs.unlinkSync(tempProbePath); } catch {}

    if (probeRes.status === 0 && probeRes.stdout) {
      const parsed = JSON.parse(probeRes.stdout.toString());
      const streams: any[] = parsed.streams || [];

      const audioStreams = streams.filter((s) => s.codec_type === 'audio');
      const audioTracks = audioStreams.map((s, idx) => {
        const lang = s.tags?.language || s.tags?.LANGUAGE || '';
        const titleTag = s.tags?.title || s.tags?.TITLE || '';
        let displayTitle = titleTag;
        if (!displayTitle) {
          if (lang) {
            displayTitle = `${lang.toUpperCase()} Audio (${s.codec_name || 'Stereo'})`;
          } else {
            displayTitle = idx === 0 ? 'Default Audio (Stereo)' : `Audio Track ${idx + 1}`;
          }
        }
        return {
          index: idx,
          language: lang || (idx === 0 ? 'und' : `track${idx + 1}`),
          title: displayTitle,
          codec: s.codec_name || 'aac',
          channels: s.channels || 2,
        };
      });

      const subStreams = streams.filter((s) => s.codec_type === 'subtitle');
      const subtitleTracks = subStreams.map((s, idx) => {
        const lang = s.tags?.language || s.tags?.LANGUAGE || 'en';
        const titleTag = s.tags?.title || s.tags?.TITLE || '';
        let displayTitle = titleTag;
        if (!displayTitle) {
          displayTitle = `${lang.toUpperCase()} Subtitles`;
        }
        return {
          index: idx,
          language: lang,
          title: displayTitle,
          format: 'vtt',
          url: `/api/media/${media.id}/subtitles/${idx}.vtt`,
        };
      });

      const finalAudio = audioTracks.length > 0 ? audioTracks : [{ index: 0, title: 'Default (Stereo)', language: 'und' }];
      updateMediaItem(media.id, {
        audioTracks: finalAudio,
        subtitleTracks,
      }).catch(() => {});

      return res.json({
        audioTracks: finalAudio,
        subtitleTracks,
      });
    }
  } catch (probeErr) {
    console.warn('[Tracks Probe Error]:', probeErr);
  }

  res.json({
    audioTracks: media.audioTracks || [{ index: 0, title: 'Default (Stereo)', language: 'und' }],
    subtitleTracks: media.subtitleTracks || [],
  });
});

// Serve extracted or on-demand WebVTT subtitle track (with optional live ?offsetMs= sync adjustment)
apiRouter.get('/media/:mediaId/subtitles/:index.vtt', async (req: Request, res: Response) => {
  const { mediaId, index } = req.params;
  const subIndex = parseInt(index, 10);
  const offsetMs = Number(req.query.offsetMs || 0);
  const subtitlesDir = path.resolve(process.cwd(), 'public_subtitles');
  if (!fs.existsSync(subtitlesDir)) fs.mkdirSync(subtitlesDir, { recursive: true });

  const sendVtt = (rawText: string) => {
    const out = offsetMs && !isNaN(offsetMs) ? applyWebVttOffset(rawText, offsetMs) : rawText;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(out);
  };

  const subFile = path.join(subtitlesDir, `sub_${mediaId}_${index}.vtt`);
  if (fs.existsSync(subFile) && fs.statSync(subFile).size > 0) {
    return sendVtt(fs.readFileSync(subFile, 'utf8'));
  }

  // If raw video file is already in stream_cache, extract subtitle immediately
  const rawCacheFile = path.join(streamCacheDir, `raw_${mediaId}.mkv`);
  if (fs.existsSync(rawCacheFile) && fs.statSync(rawCacheFile).size > 0) {
    try {
      spawnSync('ffmpeg', [
        '-y',
        '-i', rawCacheFile,
        '-map', `0:s:${subIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        subFile,
      ]);
      if (fs.existsSync(subFile) && fs.statSync(subFile).size > 0) {
        return sendVtt(fs.readFileSync(subFile, 'utf8'));
      }
    } catch (e) {
      console.warn('Local subtitle extract warning:', e);
    }
  }

  try {
    const media = await getMediaItem(mediaId);
    if (media) {
      const client = await telegramService.ensureConnected();
      const message = await telegramService.getMessageMedia(media.telegramChatId, media.telegramMessageId);
      const bigInt = (await import('big-integer')).default;

      const chunks: Buffer[] = [];
      let bytesCollected = 0;
      const subExtractLimit = 20 * 1024 * 1024;

      for await (const chunk of client.iterDownload({
        file: message.media,
        offset: bigInt(0) as any,
        requestSize: 512 * 1024,
      })) {
        chunks.push(chunk as Buffer);
        bytesCollected += chunk.length;
        if (bytesCollected >= subExtractLimit) break;
      }

      const tempVideo = path.join(uploadDir, `sub_extract_${mediaId}.tmp`);
      fs.writeFileSync(tempVideo, Buffer.concat(chunks));

      spawnSync('ffmpeg', [
        '-y',
        '-i', tempVideo,
        '-map', `0:s:${subIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        subFile,
      ]);

      try { fs.unlinkSync(tempVideo); } catch {}

      if (fs.existsSync(subFile) && fs.statSync(subFile).size > 0) {
        return sendVtt(fs.readFileSync(subFile, 'utf8'));
      }
    }
  } catch (extractErr) {
    console.warn('Subtitle extraction error:', extractErr);
  }

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send('WEBVTT\n\n');
});

// ================= REAL ANALYTICS API =================

apiRouter.get('/analytics', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const mediaId = (req.query.mediaId as string) || 'all';
    const events = await getAnalyticsEvents(mediaId);
    const mediaList = await getMediaItems();

    const countryMap: Record<string, number> = {};
    const deviceMap: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    const timelineMap: Record<string, number> = {};

    const totalViews = events.length;

    events.forEach((ev) => {
      countryMap[ev.country] = (countryMap[ev.country] || 0) + 1;
      deviceMap[ev.device] = (deviceMap[ev.device] || 0) + 1;
      osMap[ev.os] = (osMap[ev.os] || 0) + 1;

      const dateStr = ev.timestamp ? ev.timestamp.split('T')[0] : new Date().toISOString().split('T')[0];
      timelineMap[dateStr] = (timelineMap[dateStr] || 0) + 1;
    });

    const formatBreakdown = (map: Record<string, number>) => {
      return Object.entries(map)
        .map(([key, count]) => ({
          name: key,
          views: count,
          percentage: totalViews > 0 ? Number(((count / totalViews) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.views - a.views);
    };

    res.json({
      totalViews,
      mediaList: mediaList.map((m) => ({ id: m.id, title: m.title, views: m.views || 0, size: m.size })),
      countries: formatBreakdown(countryMap),
      devices: formatBreakdown(deviceMap),
      operatingSystems: formatBreakdown(osMap),
      recentEvents: events.slice(0, 50),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch analytics' });
  }
});

apiRouter.post('/analytics/view', async (req: Request, res: Response) => {
  try {
    const { mediaId, mediaTitle, clientCountry, clientDevice, clientOs } = req.body;
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId is required' });
    }

    const userAgent = req.headers['user-agent'] || '';

    // Parse Device
    let device: 'Mobile' | 'Desktop' | 'Tablet' | 'Other' = 'Desktop';
    if (clientDevice && ['Mobile', 'Desktop', 'Tablet', 'Other'].includes(clientDevice)) {
      device = clientDevice;
    } else if (/iPad|Tablet|(android(?!.*mobile))/i.test(userAgent)) {
      device = 'Tablet';
    } else if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated/i.test(userAgent)) {
      device = 'Mobile';
    }

    // Parse OS
    let os: 'Windows' | 'Android' | 'iOS' | 'macOS' | 'Linux' | 'Other' = 'Other';
    if (clientOs && ['Windows', 'Android', 'iOS', 'macOS', 'Linux', 'Other'].includes(clientOs)) {
      os = clientOs;
    } else if (/Windows/i.test(userAgent)) {
      os = 'Windows';
    } else if (/Android/i.test(userAgent)) {
      os = 'Android';
    } else if (/iPhone|iPad|iPod/i.test(userAgent)) {
      os = 'iOS';
    } else if (/Mac OS X|Macintosh/i.test(userAgent)) {
      os = 'macOS';
    } else if (/Linux/i.test(userAgent)) {
      os = 'Linux';
    }

    // Parse Browser
    let browser = 'Chrome';
    if (/Edg/i.test(userAgent)) browser = 'Edge';
    else if (/Chrome/i.test(userAgent) && !/Edg/i.test(userAgent)) browser = 'Chrome';
    else if (/Safari/i.test(userAgent) && !/Chrome/i.test(userAgent)) browser = 'Safari';
    else if (/Firefox/i.test(userAgent)) browser = 'Firefox';
    else if (/Opera|OPR/i.test(userAgent)) browser = 'Opera';

    // Parse Country from Cloudflare/CDN headers or fallback
    let country = (req.headers['cf-ipcountry'] as string) ||
                  (req.headers['x-country-code'] as string) ||
                  (req.headers['x-vercel-ip-country'] as string) ||
                  clientCountry ||
                  'Bangladesh';
    if (typeof country === 'string' && country.length === 2) {
      const codeToCountry: Record<string, string> = {
        BD: 'Bangladesh',
        US: 'United States',
        IN: 'India',
        GB: 'United Kingdom',
        CA: 'Canada',
        DE: 'Germany',
        FR: 'France',
        SG: 'Singapore',
        JP: 'Japan',
        PK: 'Pakistan',
      };
      country = codeToCountry[country.toUpperCase()] || country.toUpperCase();
    }

    const eventId = `view_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const event: AnalyticsEvent = {
      id: eventId,
      mediaId,
      mediaTitle: mediaTitle || 'Video Playback',
      timestamp: new Date().toISOString(),
      country,
      device,
      os,
      browser,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1',
    };

    await recordViewEvent(event);
    await incrementShardedView(mediaId).catch(() => {});

    res.json({ success: true, event });
  } catch (error: any) {
    console.error('Failed to record view event:', error);
    res.status(500).json({ error: error?.message || 'Failed to record view event' });
  }
});

// ================= ISSUE REPORTS API =================

apiRouter.get('/reports', requireAuth(['admin', 'editor']), async (_req: Request, res: Response) => {
  try {
    const reports = await getReports();
    res.json(reports);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch reports' });
  }
});

apiRouter.post('/reports', rateLimit('general'), async (req: Request, res: Response) => {
  try {
    const { mediaId, mediaTitle, issueType, description } = req.body;
    if (!issueType) {
      return res.status(400).json({ error: 'Issue type is required.' });
    }

    const reportId = `report_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const newReport: ReportRecord = {
      id: reportId,
      mediaId: mediaId || '',
      mediaTitle: mediaTitle || 'Unknown Video',
      issueType,
      description: description || '',
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    await saveReport(newReport);
    res.json({ success: true, report: newReport });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to submit report' });
  }
});

apiRouter.put('/reports/:id', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updated = await updateReportStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Report not found' });
    }
    await recordAudit(req, 'report.updated', 'reports', id, { status });
    res.json({ success: true, report: updated });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update report' });
  }
});

apiRouter.delete('/reports/:id', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await deleteReport(id);
    await recordAudit(req, 'report.deleted', 'reports', id);
    res.json({ success: true, message: 'Report deleted.' });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete report' });
  }
});

// ================= SERIES & PROJECTS (IDDB / TMDB / MAL / AniList) =================

apiRouter.get('/series', requireAuth(['admin', 'editor']), async (_req: Request, res: Response) => {
  try {
    const items = await getSeriesItems();
    res.json(items);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch series' });
  }
});

apiRouter.get('/series/:id', async (req: Request, res: Response) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const item = await getSeriesItem(id);
    if (!item) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(item);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch series item' });
  }
});

apiRouter.post('/series', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const data: SeriesRecord = req.body;
    if (!data.id || !data.title) {
      return res.status(400).json({ error: 'Series ID and title are required.' });
    }
    data.createdAt = data.createdAt || new Date().toISOString();
    data.updatedAt = new Date().toISOString();
    data.seasons = data.seasons || [];
    await saveSeriesItem(data);
    await recordAudit(req, 'series.saved', 'series', data.id, { title: data.title });
    res.json({ success: true, series: data });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to save series' });
  }
});

apiRouter.put('/series/:id', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const existing = await getSeriesItem(id);
    if (!existing) {
      return res.status(404).json({ error: 'Series not found' });
    }
    const updated: SeriesRecord = {
      ...existing,
      ...req.body,
      id,
      updatedAt: new Date().toISOString(),
    };
    await saveSeriesItem(updated);
    await recordAudit(req, 'series.updated', 'series', id);
    res.json({ success: true, series: updated });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update series' });
  }
});

apiRouter.delete('/series/:id', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const id = decodeURIComponent(req.params.id);
    await deleteSeriesItem(id);
    await recordAudit(req, 'series.deleted', 'series', id);
    res.json({ success: true, message: 'Series deleted.' });
  } catch (error: any) {
    console.error('Delete series error:', error);
    res.status(500).json({ error: error?.message || 'Failed to delete series' });
  }
});

// IDDB Public API Integration (Universal Media Database)
apiRouter.get('/series/iddb/search', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const query = (req.query.q as string) || '';
  const type = (req.query.type as string) || 'all';
  if (!query) return res.json([]);

  try {
    const response = await fetch(`https://taiddb.ai.studio/api/v1/search?q=${encodeURIComponent(query)}&type=${type}`);
    if (!response.ok) throw new Error('IDDB Search failed');
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/series/iddb/media/:id', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const response = await fetch(`https://taiddb.ai.studio/api/v1/media/${encodeURIComponent(req.params.id)}`);
    if (!response.ok) throw new Error(`IDDB Media ${req.params.id} not found`);
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/series/iddb/season/:id/:seasonNumber', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const response = await fetch(`https://taiddb.ai.studio/api/v1/media/${encodeURIComponent(req.params.id)}/season/${req.params.seasonNumber}`);
    if (!response.ok) throw new Error(`Season ${req.params.seasonNumber} not found`);
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/series/iddb/resolve/:provider/:externalId', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  try {
    const response = await fetch(`https://taiddb.ai.studio/api/v1/resolve/${req.params.provider}/${encodeURIComponent(req.params.externalId)}`);
    if (!response.ok) throw new Error(`Resolution failed for ${req.params.provider}:${req.params.externalId}`);
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch metadata from IDDB, TMDB, AniList or MAL API proxy
apiRouter.post('/series/fetch-metadata', requireAuth(['admin', 'editor']), async (req: Request, res: Response) => {
  const { source, sourceId } = req.body;
  if (!source || !sourceId) {
    return res.status(400).json({ error: 'Source and sourceId are required.' });
  }

  try {
    if (source === 'iddb') {
      // Direct call to IDDB Media endpoint
      const iddbId = sourceId.trim().toUpperCase().startsWith('IDDB-') ? sourceId.trim() : `IDDB-${sourceId.trim()}`;
      const response = await fetch(`https://taiddb.ai.studio/api/v1/media/${encodeURIComponent(iddbId)}`);
      if (!response.ok) {
        throw new Error(`IDDB media ${iddbId} not found.`);
      }
      const data: any = await response.json();

      const title = data.titles?.english || data.titles?.canonical || data.titles?.romaji || 'Unknown Title';
      const japaneseTitle = data.titles?.native || data.titles?.romaji;
      const description = data.synopsis || '';
      const coverImage = data.posterUrl || '';
      const bannerImage = data.backdropUrl || coverImage;
      const logoImage = data.logoUrl || '';

      const seasons = (data.seasons || []).map((s: any, idx: number) => ({
        seasonNumber: s.seasonNumber || idx + 1,
        title: s.title || `Season ${s.seasonNumber || idx + 1}`,
        episodes: (s.episodes || []).map((ep: any, epIdx: number) => ({
          episodeNumber: ep.episodeNumber || epIdx + 1,
          title: ep.title || `Episode ${ep.episodeNumber || epIdx + 1}`,
          description: ep.overview || '',
          thumbnail: ep.thumbnail || coverImage,
        })),
      }));

      const seriesRecord: SeriesRecord = {
        id: `iddb_${data.id.replace(/[^a-zA-Z0-9_\-]/g, '_')}`,
        source: 'iddb',
        sourceId: String(data.id),
        title,
        japaneseTitle,
        description,
        coverImage,
        bannerImage,
        logoImage,
        seasons: seasons.length > 0 ? seasons : [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: Array.from({ length: 12 }, (_, i) => ({
              episodeNumber: i + 1,
              title: `Episode ${i + 1}`,
              description: '',
              thumbnail: coverImage,
            })),
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return res.json({ success: true, series: seriesRecord });
    } else if (source === 'anilist') {
      const queryStr = `
        query ($id: Int) {
          Media (id: $id, type: ANIME) {
            id
            title {
              romaji
              english
              native
            }
            description
            coverImage {
              large
              extraLarge
            }
            bannerImage
            episodes
          }
        }
      `;
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: queryStr, variables: { id: parseInt(sourceId, 10) } }),
      });
      const data: any = await response.json();
      const media = data?.data?.Media;
      if (!media) throw new Error('AniList anime not found.');

      const title = media.title?.english || media.title?.romaji || 'Unknown Anime';
      const description = (media.description || '').replace(/<[^>]*>?/gm, '');
      const coverImage = media.coverImage?.extraLarge || media.coverImage?.large || '';
      const bannerImage = media.bannerImage || coverImage;

      const totalEp = media.episodes || 12;
      const episodes = Array.from({ length: totalEp }, (_, i) => ({
        episodeNumber: i + 1,
        title: `Episode ${i + 1}`,
        description: '',
        thumbnail: coverImage,
      }));

      const seriesRecord: SeriesRecord = {
        id: `anilist_${media.id}`,
        source: 'anilist',
        sourceId: String(media.id),
        title,
        japaneseTitle: media.title?.native,
        description,
        coverImage,
        bannerImage,
        seasons: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return res.json({ success: true, series: seriesRecord });
    } else if (source === 'mal') {
      const response = await fetch(`https://api.jikan.moe/v4/anime/${sourceId}`);
      const data: any = await response.json();
      const anime = data?.data;
      if (!anime) throw new Error('MAL anime not found.');

      const title = anime.title_english || anime.title || 'Unknown Anime';
      const description = anime.synopsis || '';
      const coverImage = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
      const totalEp = anime.episodes || 12;

      const episodes = Array.from({ length: totalEp }, (_, i) => ({
        episodeNumber: i + 1,
        title: `Episode ${i + 1}`,
        description: '',
        thumbnail: coverImage,
      }));

      const seriesRecord: SeriesRecord = {
        id: `mal_${anime.mal_id}`,
        source: 'mal',
        sourceId: String(anime.mal_id),
        title,
        japaneseTitle: anime.title_japanese,
        description,
        coverImage,
        bannerImage: coverImage,
        seasons: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return res.json({ success: true, series: seriesRecord });
    } else if (source === 'tmdb') {
      const tmdbKey = process.env.TMDB_API_KEY || '2d593069c8f93e9a5676b7b257c7d23f';
      const response = await fetch(`https://api.themoviedb.org/3/tv/${sourceId}?api_key=${tmdbKey}`);
      const data: any = await response.json();
      if (!data || data.success === false) throw new Error('TMDB TV Show not found.');

      const title = data.name || data.original_name || 'Unknown Show';
      const description = data.overview || '';
      const coverImage = data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : '';
      const bannerImage = data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : coverImage;

      const seasonsList = data.seasons || [{ season_number: 1, name: 'Season 1', episode_count: 12 }];
      const seasons = seasonsList.map((s: any) => {
        const epCount = s.episode_count || 10;
        const episodes = Array.from({ length: epCount }, (_, i) => ({
          episodeNumber: i + 1,
          title: `Episode ${i + 1}`,
          description: '',
          thumbnail: coverImage,
        }));
        return {
          seasonNumber: s.season_number || 1,
          title: s.name || `Season ${s.season_number || 1}`,
          episodes,
        };
      });

      const seriesRecord: SeriesRecord = {
        id: `tmdb_${data.id}`,
        source: 'tmdb',
        sourceId: String(data.id),
        title,
        japaneseTitle: data.original_name,
        description,
        coverImage,
        bannerImage,
        seasons,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return res.json({ success: true, series: seriesRecord });
    } else {
      throw new Error('Unsupported metadata source.');
    }
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to fetch external metadata.' });
  }
});
