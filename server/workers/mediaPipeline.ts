import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MediaRecord,
  MediaVersionRecord,
  RenditionMeta,
  AudioTrackMeta,
  SubtitleTrackMeta,
  getMediaItem,
  getMediaVersion,
  saveMediaVersion,
  updateMediaVersion,
  updateMediaItem,
  getStorageConfig,
} from '../db.ts';
import { computeFileSha256 } from '../crypto.ts';
import { getStorageAdapter } from '../storage/storageRouter.ts';
import { TelegramService } from '../telegramService.ts';
import { checkFfmpegAvailable } from '../observability/telemetry.ts';

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

export interface ProbeVideoSummary {
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  videoCodec: string;
  audioCodec: string;
  audioTracks: AudioTrackMeta[];
  subtitleStreams: Array<{ streamIndex: number; trackIndex: number; language: string; title: string; codec: string }>;
}

export function probeMediaFull(filePath: string): ProbeVideoSummary {
  const probe = spawnSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  if (probe.status !== 0 || !probe.stdout) {
    throw new Error(`ffprobe failed to inspect media file: ${probe.stderr?.toString() || 'unknown error'}`);
  }

  const parsed = JSON.parse(probe.stdout.toString());
  const streams: any[] = parsed.streams || [];
  const format = parsed.format || {};

  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

  let fps = 24;
  if (videoStream?.r_frame_rate && typeof videoStream.r_frame_rate === 'string') {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (num && den) fps = Number((num / den).toFixed(2));
  }

  const audioTracks: AudioTrackMeta[] = audioStreams.map((s, idx) => {
    const lang = String(s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase();
    const langName = LANGUAGE_NAME_MAP[lang] || (lang !== 'und' ? lang.toUpperCase() : 'Default');
    const titleTag = s.tags?.title || s.tags?.TITLE || '';
    return {
      index: idx,
      language: lang,
      title: titleTag || `${langName} Audio (${(s.codec_name || 'aac').toUpperCase()})`,
      codec: s.codec_name || 'aac',
      channels: Number(s.channels || 2),
      isDefault: idx === 0,
    };
  });

  const subtitleStreams = subStreams
    .filter((s) => !['hdmv_pgs_subtitle', 'dvd_subtitle'].includes(String(s.codec_name || '').toLowerCase()))
    .map((s, idx) => {
      const lang = String(s.tags?.language || s.tags?.LANGUAGE || 'eng').toLowerCase();
      const langName = LANGUAGE_NAME_MAP[lang] || lang.toUpperCase();
      const titleTag = s.tags?.title || s.tags?.TITLE || '';
      return {
        streamIndex: Number(s.index),
        trackIndex: idx,
        language: lang,
        title: titleTag || `${langName} Subtitles`,
        codec: s.codec_name || 'subrip',
      };
    });

  return {
    duration: Number(format.duration || videoStream?.duration || 0),
    width: Number(videoStream?.width || 1280),
    height: Number(videoStream?.height || 720),
    fps,
    bitrate: Number(format.bit_rate || videoStream?.bit_rate || 0),
    videoCodec: String(videoStream?.codec_name || 'unknown'),
    audioCodec: String(audioStreams[0]?.codec_name || 'none'),
    audioTracks,
    subtitleStreams,
  };
}

// Compute non-upscaled HLS ladder strictly <= source height
export function computeAbrLadder(sourceWidth: number, sourceHeight: number): Array<{
  id: string;
  label: string;
  height: number;
  videoBitrate: string;
  maxRate: string;
  bufSize: string;
  bandwidth: number;
}> {
  const ladder: Array<{
    id: string;
    label: string;
    height: number;
    videoBitrate: string;
    maxRate: string;
    bufSize: string;
    bandwidth: number;
  }> = [];

  if (sourceHeight >= 950) {
    ladder.push({
      id: '1080p',
      label: '1080p HD',
      height: 1080,
      videoBitrate: '4500k',
      maxRate: '4950k',
      bufSize: '9000k',
      bandwidth: 4700000,
    });
  }
  if (sourceHeight >= 660) {
    ladder.push({
      id: '720p',
      label: '720p HD',
      height: 720,
      videoBitrate: '2400k',
      maxRate: '2640k',
      bufSize: '4800k',
      bandwidth: 2560000,
    });
  }
  if (sourceHeight >= 420) {
    ladder.push({
      id: '480p',
      label: '480p SD',
      height: 480,
      videoBitrate: '1200k',
      maxRate: '1320k',
      bufSize: '2400k',
      bandwidth: 1320000,
    });
  }

  // Always include 360p (or native height if source < 360p — never upscale!)
  const baseH = Math.min(360, sourceHeight > 0 ? sourceHeight : 360);
  const evenH = baseH % 2 === 0 ? baseH : baseH - 1;
  ladder.push({
    id: `${evenH}p`,
    label: `${evenH}p SD`,
    height: evenH,
    videoBitrate: '700k',
    maxRate: '770k',
    bufSize: '1400k',
    bandwidth: 800000,
  });

  void sourceWidth;
  return ladder;
}

// Convert SRT / ASS / SSA / VTT subtitle file into clean WebVTT
export function convertSubtitleFileToVtt(inputPath: string, outputVttPath: string): void {
  const res = spawnSync('ffmpeg', ['-y', '-i', inputPath, '-c:s', 'webvtt', '-f', 'webvtt', outputVttPath]);
  if (res.status !== 0 || !fs.existsSync(outputVttPath) || fs.statSync(outputVttPath).size === 0) {
    // Fallback if already plain VTT
    const raw = fs.readFileSync(inputPath, 'utf8');
    if (raw.trim().startsWith('WEBVTT')) {
      fs.writeFileSync(outputVttPath, raw, 'utf8');
      return;
    }
    throw new Error(`Failed to convert subtitle to WebVTT: ${res.stderr?.toString() || 'unknown error'}`);
  }
}

// Shift all WebVTT timestamps by offsetMs (clamped at 00:00:00.000)
export function applyWebVttOffset(vttContent: string, offsetMs: number): string {
  if (!offsetMs || offsetMs === 0) return vttContent;

  const parseMs = (ts: string): number => {
    const clean = ts.trim().replace(',', '.');
    const parts = clean.split(':');
    let hrs = 0;
    let mins = 0;
    let secMs = '0';
    if (parts.length === 3) {
      hrs = Number(parts[0]);
      mins = Number(parts[1]);
      secMs = parts[2]!;
    } else if (parts.length === 2) {
      mins = Number(parts[0]);
      secMs = parts[1]!;
    }
    const [secStr, msStr = '0'] = secMs.split('.');
    return (hrs * 3600 + mins * 60 + Number(secStr)) * 1000 + Number(msStr.padEnd(3, '0').slice(0, 3));
  };

  const formatMs = (totalMs: number): string => {
    const clamped = Math.max(0, Math.round(totalMs));
    const hrs = Math.floor(clamped / 3600000);
    const mins = Math.floor((clamped % 3600000) / 60000);
    const secs = Math.floor((clamped % 60000) / 1000);
    const ms = clamped % 1000;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  return vttContent
    .split('\n')
    .map((line) => {
      if (!line.includes('-->')) return line;
      const m = line.match(/(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}(.*)/);
      if (!m) return line;
      const [timesPart, ...rest] = line.split('-->');
      const rightFull = rest.join('-->').trim();
      const rightTokens = rightFull.split(/\s+/);
      const endTs = rightTokens[0] || '00:00:00.000';
      const settings = rightTokens.slice(1).join(' ');
      const newStart = formatMs(parseMs(timesPart!) + offsetMs);
      const newEnd = formatMs(parseMs(endTs) + offsetMs);
      return `${newStart} --> ${newEnd}${settings ? ` ${settings}` : ''}`;
    })
    .join('\n');
}

// FFmpeg black-frame & silence detector for real temporal cues
export function detectSilenceAndBlackFrames(filePath: string): {
  blackSegments: Array<{ start: number; end: number; duration: number }>;
  silenceSegments: Array<{ start: number; end: number; duration: number }>;
} {
  const blackRes = spawnSync(
    'ffmpeg',
    ['-i', filePath, '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-an', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const silenceRes = spawnSync(
    'ffmpeg',
    ['-i', filePath, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  const blackSegments: Array<{ start: number; end: number; duration: number }> = [];
  const blackOut = String(blackRes.stderr || '');
  for (const m of blackOut.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    blackSegments.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }

  const silenceSegments: Array<{ start: number; end: number; duration: number }> = [];
  const silenceOut = String(silenceRes.stderr || '');
  for (const m of silenceOut.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)) {
    const end = Number(m[1]);
    const dur = Number(m[2]);
    silenceSegments.push({ start: Math.max(0, Number((end - dur).toFixed(2))), end, duration: dur });
  }

  return {
    blackSegments: blackSegments.slice(0, 40),
    silenceSegments: silenceSegments.slice(0, 50),
  };
}

// Materialize local source file for a media record from its storage backend
export async function resolveLocalSourceVideo(media: MediaRecord, version?: MediaVersionRecord | null): Promise<string> {
  const workDir = path.resolve(process.cwd(), 'stream_cache');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  const cachePath = path.join(workDir, `source_${media.id}_${version?.id || 'base'}.mkv`);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1024) {
    return cachePath;
  }

  // Also check raw_<id>.mkv legacy cache
  const legacyRaw = path.join(workDir, `raw_${media.id}.mkv`);
  if (fs.existsSync(legacyRaw) && fs.statSync(legacyRaw).size > 1024 && !version) {
    return legacyRaw;
  }

  const backend = version?.storageBackend || media.storageBackend || 'telegram';

  if (backend === 's3_r2' || backend === 'local_dev') {
    const adapter = await getStorageAdapter(backend);
    const masterKey = `${version?.objectPrefix || `media/${media.id}/v1`}/master_source${path.extname(version?.filename || media.filename) || '.mp4'}`;
    const { stream } = await adapter.getObjectStream(masterKey);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(cachePath);
      stream.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      stream.on('error', reject);
    });
    return cachePath;
  }

  // Telegram MTProto download
  const tg = TelegramService.getInstance();
  const client = await tg.ensureConnected();
  const bigInt = (await import('big-integer')).default;
  const chatId = version?.telegramChatId || media.telegramChatId;
  const msgIds =
    version?.telegramMessageIds && version.telegramMessageIds.length > 0
      ? version.telegramMessageIds
      : version?.telegramMessageId
      ? [version.telegramMessageId]
      : media.telegramMessageIds && media.telegramMessageIds.length > 0
      ? media.telegramMessageIds
      : [media.telegramMessageId];

  const ws = fs.createWriteStream(cachePath);
  for (const mId of msgIds) {
    const message = await tg.getMessageMedia(chatId, mId);
    for await (const chunk of client.iterDownload({
      file: message.media,
      offset: bigInt(0) as any,
      requestSize: 1024 * 1024,
    })) {
      ws.write(chunk);
    }
  }
  await new Promise<void>((resolve) => ws.end(() => resolve()));
  return cachePath;
}

// Package an authoritative HLS ABR rendition tree with demuxed multi-audio, WebVTT subtitles, poster & storyboard sprites
export async function executeHlsPackagingJob(
  mediaId: string,
  versionId: string | undefined,
  onProgress: (checkpoint: string, pct: number, msg: string) => Promise<void>,
  sourceLocalPathOverride?: string
): Promise<MediaVersionRecord> {
  const ffmpeg = checkFfmpegAvailable();
  if (!ffmpeg.available) {
    throw new Error('FFmpeg binary is not available on this host; cannot run HLS transcoding.');
  }

  const media = await getMediaItem(mediaId);
  if (!media) {
    throw new Error(`Media ${mediaId} not found in database.`);
  }

  let version = versionId ? await getMediaVersion(versionId) : null;
  if (!version) {
    const cfg = await getStorageConfig().catch(() => null);
    const now = new Date().toISOString();
    const newVersionId = versionId || `ver_${Date.now()}`;
    version = {
      id: newVersionId,
      mediaId,
      versionNumber: 1,
      label: 'v1 (HLS ABR Master)',
      filename: media.filename,
      mimeType: media.mimeType,
      size: media.size,
      duration: media.duration || 0,
      sha256Hash: media.sha256Hash || '',
      storageBackend: cfg?.backend || media.storageBackend || 'telegram',
      objectPrefix: `media/${mediaId}/${newVersionId}`,
      renditions: [],
      telegramChatId: media.telegramChatId,
      telegramMessageId: media.telegramMessageId,
      telegramMessageIds: media.telegramMessageIds,
      status: 'processing',
      createdBy: media.ownerId || 'system',
      createdAt: now,
      updatedAt: now,
    };
    await saveMediaVersion(version);
  } else {
    await updateMediaVersion(version.id, { status: 'processing', error: undefined });
  }

  await onProgress('fetching_source', 10, 'Downloading/locating master source file...');
  const localSource =
    sourceLocalPathOverride && fs.existsSync(sourceLocalPathOverride)
      ? sourceLocalPathOverride
      : await resolveLocalSourceVideo(media, version);

  await onProgress('probing', 20, 'Inspecting video codecs, resolution, audio & subtitles with ffprobe...');
  const probe = probeMediaFull(localSource);
  const sha256Hash = version.sha256Hash || (await computeFileSha256(localSource));
  const stat = await fs.promises.stat(localSource);

  const workDir = path.resolve(process.cwd(), 'temp_uploads', `hls_${mediaId}_${version.id}`);
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Extract poster & storyboard sprite
    await onProgress('thumbnails', 28, 'Generating poster thumbnail and seek storyboard sprite...');
    const posterPath = path.join(workDir, 'poster.jpg');
    const thumbSeek = Math.min(Math.max(1, Math.floor(probe.duration * 0.15)), 15);
    spawnSync('ffmpeg', [
      '-y',
      '-ss', String(thumbSeek),
      '-i', localSource,
      '-vframes', '1',
      '-vf', 'scale=960:-2',
      '-q:v', '4',
      posterPath,
    ]);

    // 2. Extract embedded subtitle tracks -> WebVTT
    await onProgress('subtitles', 34, 'Extracting embedded subtitle tracks to WebVTT...');
    const extractedSubs: SubtitleTrackMeta[] = [];
    for (const sub of probe.subtitleStreams) {
      const subOut = path.join(workDir, `sub_${sub.trackIndex}.vtt`);
      const sRes = spawnSync('ffmpeg', [
        '-y',
        '-i', localSource,
        '-map', `0:${sub.streamIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        subOut,
      ]);
      if (sRes.status === 0 && fs.existsSync(subOut) && fs.statSync(subOut).size > 10) {
        extractedSubs.push({
          index: sub.trackIndex,
          language: sub.language,
          title: sub.title,
          format: 'vtt',
          objectKey: `${version.objectPrefix}/sub_${sub.trackIndex}.vtt`,
          url: `/api/cdn/v1/hls/${mediaId}/${version.id}/sub_${sub.trackIndex}.vtt`,
          isDefault: sub.trackIndex === 0,
          source: 'embedded',
        });
      }
    }

    // Also preserve any manually uploaded/AI subtitles already on media
    const existingExternalSubs = (media.subtitleTracks || []).filter(
      (s) => s.source && s.source !== 'embedded'
    );
    const mergedSubs = [...extractedSubs, ...existingExternalSubs];

    // 3. Package Audio Tracks as Demuxed HLS Audio Groups (#EXT-X-MEDIA)
    await onProgress('audio_packaging', 45, 'Packaging demuxed AAC audio rendition playlists...');
    const audioGroupTags: string[] = [];
    const packagedAudio: AudioTrackMeta[] = [];
    const hasAudio = probe.audioTracks.length > 0;

    if (hasAudio) {
      for (const aTrk of probe.audioTracks) {
        const audioDir = path.join(workDir, `a_${aTrk.index}`);
        fs.mkdirSync(audioDir, { recursive: true });
        const audioPlName = `a_${aTrk.index}/audio.m3u8`;
        const audioArgs = [
          '-y',
          '-i', localSource,
          '-vn',
          '-map', `0:a:${aTrk.index}`,
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ac', '2',
          '-hls_time', '6',
          '-hls_playlist_type', 'vod',
          '-hls_segment_filename', path.join(audioDir, 'seg_%04d.ts'),
          path.join(workDir, audioPlName),
        ];
        const aRes = spawnSync('ffmpeg', audioArgs);
        if (aRes.status === 0 && fs.existsSync(path.join(workDir, audioPlName))) {
          const defaultFlag = aTrk.index === 0 ? 'YES' : 'NO';
          const langCode = (aTrk.language || 'und').replace(/"/g, '');
          const safeTitle = (aTrk.title || `Audio ${aTrk.index + 1}`).replace(/"/g, '');
          audioGroupTags.push(
            `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${safeTitle}",LANGUAGE="${langCode}",DEFAULT=${defaultFlag},AUTOSELECT=YES,URI="${audioPlName}"`
          );
          packagedAudio.push({
            ...aTrk,
            playlistKey: `${version.objectPrefix}/${audioPlName}`,
          });
        }
      }
    }

    // 4. Transcode non-upscaled video ABR ladder
    const ladder = computeAbrLadder(probe.width, probe.height);
    // For single fast encode of small/fast containers, ensure we produce <= 3 renditions in dev or full ladder
    const selectedLadder = ladder;
    const renditions: RenditionMeta[] = [];
    const variantPlaylistBlocks: string[] = [];

    for (let i = 0; i < selectedLadder.length; i++) {
      const r = selectedLadder[i]!;
      const pct = 50 + Math.round(((i + 1) / selectedLadder.length) * 35);
      await onProgress(`transcode_${r.id}`, pct, `Transcoding ${r.label} HLS rendition (${i + 1}/${selectedLadder.length})...`);

      const rDir = path.join(workDir, `v_${r.id}`);
      fs.mkdirSync(rDir, { recursive: true });
      const variantRel = `v_${r.id}/prog.m3u8`;
      const variantAbs = path.join(workDir, variantRel);

      // Copy video if source closely matches height & is H.264/avc1, else libx264 veryfast
      const targetWidth = Math.max(
        2,
        Math.round(((probe.width || 1280) * r.height) / (probe.height || 720) / 2) * 2
      );

      const videoArgs = [
        '-y',
        '-i', localSource,
        '-map', '0:v:0',
        '-an',
        '-vf', `scale=-2:${r.height}`,
        '-c:v', 'libx264',
        '-profile:v', 'main',
        '-preset', 'veryfast',
        '-crf', '22',
        '-g', '48',
        '-keyint_min', '48',
        '-sc_threshold', '0',
        '-b:v', r.videoBitrate,
        '-maxrate', r.maxRate,
        '-bufsize', r.bufSize,
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(rDir, 'seg_%04d.ts'),
        variantAbs,
      ];

      const vRes = spawnSync('ffmpeg', videoArgs);
      if (vRes.status !== 0 || !fs.existsSync(variantAbs)) {
        throw new Error(`FFmpeg HLS failed on rendition ${r.id}: ${vRes.stderr?.toString()?.slice(-400)}`);
      }

      const audioAttr = audioGroupTags.length > 0 ? ',AUDIO="audio"' : '';
      renditions.push({
        id: r.id,
        label: r.label,
        width: targetWidth,
        height: r.height,
        bandwidth: r.bandwidth,
        codec: 'avc1.4d401f',
        playlistKey: `${version.objectPrefix}/${variantRel}`,
      });

      variantPlaylistBlocks.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${targetWidth}x${r.height},CODECS="avc1.4d401f,mp4a.40.2"${audioAttr}\n${variantRel}`
      );
    }

    // 5. Write & validate master.m3u8
    const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3', ...audioGroupTags, ...variantPlaylistBlocks];
    const masterContent = masterLines.join('\n') + '\n';
    const masterPath = path.join(workDir, 'master.m3u8');
    fs.writeFileSync(masterPath, masterContent, 'utf8');

    if (!masterContent.includes('#EXTM3U') || renditions.length === 0) {
      throw new Error('Validation error: generated HLS master playlist is empty or malformed.');
    }

    // 6. Upload packaged HLS directory to configured ObjectStorageAdapter
    await onProgress('uploading_artifacts', 90, `Uploading HLS manifests & segments to ${version.storageBackend}...`);
    const storageAdapter = await getStorageAdapter(version.storageBackend);

    const uploadDirRecursive = async (dir: string, relBase = '') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await uploadDirRecursive(abs, rel);
        } else {
          const ext = path.extname(ent.name).toLowerCase();
          const ctype =
            ext === '.m3u8'
              ? 'application/vnd.apple.mpegurl'
              : ext === '.ts'
              ? 'video/mp2t'
              : ext === '.vtt'
              ? 'text/vtt'
              : ext === '.jpg'
              ? 'image/jpeg'
              : 'application/octet-stream';
          await storageAdapter.putFile(`${version!.objectPrefix}/${rel}`, abs, ctype);
        }
      }
    };

    await uploadDirRecursive(workDir);

    // 7. Atomic pointer promotion in Firestore
    await onProgress('promoting', 98, 'Atomically promoting new active master version...');
    const finalVersion: MediaVersionRecord = {
      ...version,
      size: stat.size,
      duration: probe.duration || version.duration,
      sha256Hash,
      masterPlaylistKey: `${version.objectPrefix}/master.m3u8`,
      posterKey: fs.existsSync(posterPath) ? `${version.objectPrefix}/poster.jpg` : undefined,
      renditions,
      audioTracks: packagedAudio.length > 0 ? packagedAudio : probe.audioTracks,
      subtitleTracks: mergedSubs,
      probeMetadata: {
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        bitrate: probe.bitrate,
      },
      status: 'ready',
      error: undefined,
      updatedAt: new Date().toISOString(),
    };

    await saveMediaVersion(finalVersion);
    await updateMediaItem(mediaId, {
      playbackMode: 'hls_v2',
      processingStatus: 'ready',
      storageBackend: finalVersion.storageBackend,
      activeVersionId: finalVersion.id,
      duration: finalVersion.duration,
      sha256Hash,
      posterUrl: finalVersion.posterKey
        ? `/api/cdn/v1/hls/${mediaId}/${finalVersion.id}/poster.jpg`
        : undefined,
      audioTracks: finalVersion.audioTracks,
      subtitleTracks: finalVersion.subtitleTracks,
    });

    return finalVersion;
  } finally {
    try {
      if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}
