// Client-side Video Transcoding & Remuxing Pipeline using FFmpeg.wasm
// Converts non-streamable containers (like MKV) to faststart H.264/AAC MP4 before uploading to cloud storage.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpegInstance: FFmpeg | null = null;
let isFfmpegLoading = false;
let loadPromise: Promise<FFmpeg> | null = null;

// Determine if a video file requires transcoding / remuxing before streaming
export function isTranscodingNeeded(file: File): boolean {
  if (!file) return false;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();

  // Non-streamable or problematic browser containers
  const nonStreamableExtensions = ['.mkv', '.avi', '.flv', '.wmv', '.mov', '.ts', '.vob', '.m4v'];
  const hasNonStreamableExt = nonStreamableExtensions.some((ext) => name.endsWith(ext));
  const hasNonStreamableMime =
    type.includes('matroska') ||
    type.includes('mkv') ||
    type.includes('avi') ||
    type.includes('flv') ||
    type.includes('quicktime');

  return hasNonStreamableExt || hasNonStreamableMime;
}

// Single-threaded core URL (does not require COOP/COEP headers, safe for iframes and cross-origin)
const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

async function getFFmpegInstance(
  onProgressCallback?: (percent: number, message: string) => void
): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    isFfmpegLoading = true;
    try {
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        // Helpful diagnostic logs
        if (message.includes('time=') || message.includes('fps=') || message.includes('frame=')) {
          // Parse progress details if available
        }
      });

      if (onProgressCallback) {
        onProgressCallback(5, 'Loading video converter module...');
      }

      const coreURL = await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');

      await ffmpeg.load({
        coreURL,
        wasmURL,
      });

      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } finally {
      isFfmpegLoading = false;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export interface TranscodeProgress {
  percent: number;
  stage: 'loading' | 'preparing' | 'transcoding' | 'finalizing' | 'complete' | 'fallback';
  statusText: string;
}

/**
 * Transcodes or remuxes a non-streamable video (e.g. MKV) into an H.264/AAC faststart MP4 file.
 * Returns the converted File object.
 */
export async function transcodeVideoFile(
  file: File,
  onProgress?: (progress: TranscodeProgress) => void
): Promise<{ file: File; converted: boolean; message?: string }> {
  if (!isTranscodingNeeded(file)) {
    return { file, converted: false };
  }

  const baseName = file.name.replace(/\.[^/.]+$/, '');
  const outputFileName = `${baseName}.mp4`;

  // Memory guard: FFmpeg 32-bit wasm has an addressable memory ceiling (~512MB-1GB in browsers).
  // If the file is excessively large (e.g. > 350MB), client-side wasm can crash due to heap exhaustion.
  // In that case, we delegate to the server-side high-speed FFmpeg remuxer on upload.
  const MAX_WASM_SAFE_SIZE = 350 * 1024 * 1024; // 350 MB
  if (file.size > MAX_WASM_SAFE_SIZE) {
    onProgress?.({
      percent: 100,
      stage: 'fallback',
      statusText: 'Large file detected: Delegating to high-speed server pipeline...',
    });
    return {
      file,
      converted: false,
      message: 'Delegated to server pipeline for memory safety',
    };
  }

  try {
    onProgress?.({
      percent: 5,
      stage: 'loading',
      statusText: 'Initializing video converter...',
    });

    const ffmpeg = await getFFmpegInstance((percent, msg) => {
      onProgress?.({
        percent,
        stage: 'loading',
        statusText: msg,
      });
    });

    // Clean any residual files in virtual filesystem
    try { await ffmpeg.deleteFile('input'); } catch {}
    try { await ffmpeg.deleteFile('output.mp4'); } catch {}

    onProgress?.({
      percent: 15,
      stage: 'preparing',
      statusText: 'Preparing video file data...',
    });

    const inputData = await fetchFile(file);
    await ffmpeg.writeFile('input', inputData);

    onProgress?.({
      percent: 25,
      stage: 'transcoding',
      statusText: 'Remuxing video container to MP4 (H.264/AAC)...',
    });

    let lastReportedRatio = 0.25;
    const progressHandler = ({ progress }: { progress: number }) => {
      // Progress from 0.25 to 0.90
      const current = Math.min(0.9, Math.max(0.25, 0.25 + progress * 0.65));
      if (current - lastReportedRatio > 0.05 || current >= 0.88) {
        lastReportedRatio = current;
        onProgress?.({
          percent: Math.round(current * 100),
          stage: 'transcoding',
          statusText: `Converting video (${Math.round(progress * 100)}%)...`,
        });
      }
    };

    ffmpeg.on('progress', progressHandler);

    // Attempt 1: Ultra-fast stream remux (keeps original H.264 video, converts audio to AAC, +faststart)
    let exitCode = await ffmpeg.exec([
      '-i', 'input',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      'output.mp4',
    ]);

    // Attempt 2: If stream copy failed (e.g. non-H.264 codec like HEVC/VP9 in MKV), re-encode to H.264
    if (exitCode !== 0) {
      onProgress?.({
        percent: 45,
        stage: 'transcoding',
        statusText: 'Re-encoding video stream to H.264 for maximum browser compatibility...',
      });

      try { await ffmpeg.deleteFile('output.mp4'); } catch {}

      exitCode = await ffmpeg.exec([
        '-i', 'input',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '24',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        'output.mp4',
      ]);
    }

    ffmpeg.off('progress', progressHandler);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with error code ${exitCode}`);
    }

    onProgress?.({
      percent: 92,
      stage: 'finalizing',
      statusText: 'Finalizing streamable MP4...',
    });

    const data = await ffmpeg.readFile('output.mp4');
    const mp4Bytes = data instanceof Uint8Array ? data : new Uint8Array(data as any);

    // Clean up memory
    try { await ffmpeg.deleteFile('input'); } catch {}
    try { await ffmpeg.deleteFile('output.mp4'); } catch {}

    const convertedFile = new File([mp4Bytes], outputFileName, {
      type: 'video/mp4',
      lastModified: Date.now(),
    });

    onProgress?.({
      percent: 100,
      stage: 'complete',
      statusText: 'Conversion complete! Proceeding to upload...',
    });

    return {
      file: convertedFile,
      converted: true,
      message: 'Successfully converted to H.264/AAC MP4',
    };
  } catch (err: any) {
    console.warn('[Client Transcoding Warning] FFmpeg.wasm failed, falling back:', err?.message || err);
    onProgress?.({
      percent: 100,
      stage: 'fallback',
      statusText: 'Client converter skipped; upload will proceed via server pipeline...',
    });

    // Graceful fallback: return original file so the user is never blocked
    return {
      file,
      converted: false,
      message: err?.message || 'Fallback to server processing',
    };
  }
}
