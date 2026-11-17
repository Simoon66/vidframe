import { auth } from './firebase';
import {
  MediaItem,
  SystemStatus,
  StorageConfig,
  StorageBackendMode,
  PaginatedMediaResponse,
  MediaVersionItem,
  ProcessingJobItem,
  IntroSuggestionItem,
  PlaybackDescriptor,
  AdminUserItem,
  ApiKeyItem,
  AuditLogItem,
  AiProviderInfo,
} from '../types/media';

async function getAuthHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  try {
    const user = auth.currentUser;
    if (user) {
      const token = await user.getIdToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
  } catch {}
  return headers;
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const baseHeaders: Record<string, string> = {};
  if (init.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => {
      baseHeaders[k] = v;
    });
  }
  const headers = await getAuthHeaders(baseHeaders);
  return fetch(input, { ...init, headers });
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await authFetch('/api/status');
  if (!res.ok) throw new Error('Failed to fetch system status');
  return res.json();
}

export async function saveTelegramCredentials(apiId: number, apiHash: string): Promise<any> {
  const res = await authFetch('/api/telegram/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiId, apiHash }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save credentials');
  return data;
}

export async function sendTelegramCode(phoneNumber: string): Promise<any> {
  const res = await authFetch('/api/telegram/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send code');
  return data;
}

export async function verifyTelegramCode(code: string): Promise<{ success: boolean; requires2FA?: boolean }> {
  const res = await authFetch('/api/telegram/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify code');
  return data;
}

export async function verifyTelegram2FA(password: string): Promise<{ success: boolean }> {
  const res = await authFetch('/api/telegram/verify-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify 2FA password');
  return data;
}

export async function disconnectTelegram(): Promise<void> {
  const res = await authFetch('/api/telegram/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}

export async function reconnectTelegram(): Promise<any> {
  const res = await authFetch('/api/telegram/reconnect', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to reconnect Telegram client');
  return data;
}

export async function testStorageChat(chatId: string): Promise<{ success: boolean; storage: StorageConfig }> {
  const res = await authFetch('/api/storage/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify chat ID');
  return data;
}

export async function saveAndTestS3Storage(payload: {
  endpoint: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string;
  cdnBaseUrl?: string;
  forcePathStyle?: boolean;
  activateAsDefault?: boolean;
}): Promise<{ success: boolean; detail: string; storage: StorageConfig }> {
  const res = await authFetch('/api/storage/s3-test-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify S3/R2 bucket');
  return data;
}

export async function switchStorageBackend(backend: StorageBackendMode): Promise<{ success: boolean; storage: StorageConfig }> {
  const res = await authFetch('/api/storage/switch-backend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to switch storage backend');
  return data;
}

export async function fetchMediaItems(): Promise<MediaItem[]> {
  const res = await authFetch('/api/media');
  if (!res.ok) throw new Error('Failed to fetch media');
  return res.json();
}

export async function fetchMediaPaginated(opts: {
  limit?: number;
  cursor?: string | null;
  visibility?: string;
  folder?: string;
  status?: string;
  search?: string;
} = {}): Promise<PaginatedMediaResponse> {
  const params = new URLSearchParams({ paginated: 'true' });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.visibility && opts.visibility !== 'all') params.set('visibility', opts.visibility);
  if (opts.folder && opts.folder !== 'all') params.set('folder', opts.folder);
  if (opts.status && opts.status !== 'all') params.set('status', opts.status);
  if (opts.search?.trim()) params.set('search', opts.search.trim());

  const res = await authFetch(`/api/media?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch paginated media');
  return res.json();
}

export async function fetchMediaItem(id: string): Promise<MediaItem> {
  const res = await authFetch(`/api/media/${id}`);
  if (!res.ok) throw new Error('Media not found');
  return res.json();
}

export async function fetchPlaybackDescriptor(id: string, token?: string): Promise<PlaybackDescriptor> {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const res = await authFetch(`/api/media/${encodeURIComponent(id)}/playback${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Playback descriptor unavailable');
  return data;
}

export async function mintSignedPlaybackGrant(id: string, ttlSeconds = 3600): Promise<{ token: string; hlsUrl: string }> {
  const res = await authFetch(`/api/media/${encodeURIComponent(id)}/sign-playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttlSeconds }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to mint signed URL');
  return data;
}

export async function updateMediaItem(id: string, updates: Partial<MediaItem>): Promise<MediaItem> {
  const res = await authFetch(`/api/media/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update media');
  return data.media;
}

export async function deleteMediaItem(id: string): Promise<void> {
  const res = await authFetch(`/api/media/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete media');
}

export async function uploadMediaFile(
  formData: FormData,
  onProgress?: (progress: number, statusText?: string) => void,
  onAbortRef?: { abort?: () => void }
): Promise<{ success: boolean; media: MediaItem; duplicateWarning?: { id: string; title: string } | null }> {
  const file = formData.get('video') as File | null;
  const title = (formData.get('title') as string) || (file ? file.name : 'Untitled');
  const description = (formData.get('description') as string) || '';
  const visibility = (formData.get('visibility') as string) || 'public';
  const folder = (formData.get('folder') as string) || '';
  const introStart = formData.get('introStart') ? Number(formData.get('introStart')) : 0;
  const introEnd = formData.get('introEnd') ? Number(formData.get('introEnd')) : 0;
  const outroStart = formData.get('outroStart') ? Number(formData.get('outroStart')) : 0;
  const outroEnd = formData.get('outroEnd') ? Number(formData.get('outroEnd')) : 0;

  const authHeaders = await getAuthHeaders();

  if (!file || !(file instanceof File)) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
      Object.entries(authHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (onAbortRef) {
        onAbortRef.abort = () => {
          xhr.abort();
          reject(new Error('Upload cancelled by user.'));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Invalid response format'));
          }
        } else {
          try {
            const errRes = JSON.parse(xhr.responseText);
            reject(new Error(errRes.error || `Upload failed with status ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload cancelled by user.'));
      xhr.send(formData);
    });
  }

  const CHUNK_SIZE = 2 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `up_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  let isAborted = false;
  const activeXhrs = new Set<XMLHttpRequest>();

  if (onAbortRef) {
    onAbortRef.abort = () => {
      isAborted = true;
      activeXhrs.forEach((xhr) => {
        try {
          xhr.abort();
        } catch {}
      });
      activeXhrs.clear();
    };
  }

  const chunkLoadedBytes = new Array(totalChunks).fill(0);

  const uploadChunk = async (chunkIndex: number): Promise<void> => {
    if (isAborted) throw new Error('Upload cancelled by user.');

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    const chunkSize = end - start;

    const chunkForm = new FormData();
    chunkForm.append('chunk', chunkBlob, `${file.name}.part${chunkIndex}`);
    chunkForm.append('uploadId', uploadId);
    chunkForm.append('chunkIndex', String(chunkIndex));
    chunkForm.append('totalChunks', String(totalChunks));

    const chunkAuth = await getAuthHeaders();

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);
      xhr.open('POST', '/api/media/upload-chunk');
      Object.entries(chunkAuth).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.timeout = 90000;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          chunkLoadedBytes[chunkIndex] = e.loaded;
        }
        if (onProgress) {
          const totalLoaded = chunkLoadedBytes.reduce((a, b) => a + b, 0);
          const percent = Math.min(88, Math.round((totalLoaded / file.size) * 88));
          onProgress(percent);
        }
      };

      xhr.onload = () => {
        activeXhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          chunkLoadedBytes[chunkIndex] = chunkSize;
          if (onProgress) {
            const totalLoaded = chunkLoadedBytes.reduce((a, b) => a + b, 0);
            const percent = Math.min(88, Math.round((totalLoaded / file.size) * 88));
            onProgress(percent);
          }
          resolve();
        } else {
          try {
            const errData = JSON.parse(xhr.responseText);
            reject(new Error(errData.error || `Chunk upload failed with status ${xhr.status}`));
          } catch {
            reject(new Error(`Chunk upload failed with status ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        activeXhrs.delete(xhr);
        reject(new Error('Network glitch during chunk upload. Retrying...'));
      };

      xhr.ontimeout = () => {
        activeXhrs.delete(xhr);
        reject(new Error('Chunk upload timed out on current connection. Retrying...'));
      };

      xhr.onabort = () => {
        activeXhrs.delete(xhr);
        reject(new Error('Upload cancelled by user.'));
      };

      xhr.send(chunkForm);
    });
  };

  const uploadChunkWithRetry = async (chunkIndex: number, maxRetries = 5): Promise<void> => {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (isAborted) throw new Error('Upload cancelled by user.');
      try {
        await uploadChunk(chunkIndex);
        return;
      } catch (err: any) {
        lastError = err;
        if (isAborted) throw err;
        if (attempt < maxRetries) {
          chunkLoadedBytes[chunkIndex] = 0;
          if (onProgress) {
            const totalLoaded = chunkLoadedBytes.reduce((a, b) => a + b, 0);
            const percent = Math.min(88, Math.round((totalLoaded / file.size) * 88));
            onProgress(
              percent,
              `Re-connecting & retrying chunk ${chunkIndex + 1} of ${totalChunks} (attempt ${attempt + 1}/${maxRetries})...`
            );
          }
          await new Promise((r) => setTimeout(r, Math.min(800 * attempt, 3500)));
        }
      }
    }
    throw lastError || new Error(`Network connection failed while uploading video chunk.`);
  };

  const CONCURRENCY = Math.min(2, totalChunks);
  let nextChunkIndex = 0;

  async function worker() {
    while (nextChunkIndex < totalChunks) {
      if (isAborted) throw new Error('Upload cancelled by user.');
      const currentIndex = nextChunkIndex++;
      await uploadChunkWithRetry(currentIndex);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  if (isAborted) {
    throw new Error('Upload cancelled by user.');
  }

  if (onProgress) {
    onProgress(89, 'Chunks uploaded. Assembling video file on server...');
  }

  let pollInterval: any = null;
  let serverReportedCompleteResult: any = null;

  const startPolling = () => {
    pollInterval = setInterval(async () => {
      if (isAborted) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const progRes = await authFetch(`/api/media/upload-progress/${uploadId}`);
        if (progRes.ok) {
          const progData = await progRes.json();
          if (onProgress && typeof progData.overallPercent === 'number') {
            onProgress(progData.overallPercent, progData.statusText);
          }
          if (progData.stage === 'complete') {
            serverReportedCompleteResult = progData.result;
            clearInterval(pollInterval);
          } else if (progData.stage === 'error') {
            clearInterval(pollInterval);
          }
        }
      } catch {}
    }, 600);
  };

  startPolling();

  try {
    const finishRes = await authFetch('/api/media/upload-finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        totalChunks,
        originalName: file.name,
        mimeType: file.type || (file.name.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4'),
        title,
        description,
        visibility,
        folder,
        introStart,
        introEnd,
        outroStart,
        outroEnd,
      }),
    });

    clearInterval(pollInterval);

    if (finishRes.ok) {
      const finishData = await finishRes.json();
      if (onProgress) onProgress(100, 'Upload complete! HLS packaging queued.');
      return finishData;
    }

    if (serverReportedCompleteResult) {
      if (onProgress) onProgress(100, 'Upload complete! HLS packaging queued.');
      return serverReportedCompleteResult;
    }

    const finishData = await finishRes.json().catch(() => ({}));
    throw new Error(finishData.error || 'Failed to finalize video upload on server');
  } catch (err: any) {
    clearInterval(pollInterval);
    if (serverReportedCompleteResult) {
      if (onProgress) onProgress(100, 'Upload complete! HLS packaging queued.');
      return serverReportedCompleteResult;
    }
    throw err;
  }
}

export async function uploadMediaUrl(payload: {
  url: string;
  title?: string;
  description?: string;
  visibility?: string;
  folder?: string;
}): Promise<{ success: boolean; media: MediaItem; duplicateWarning?: { id: string; title: string } | null }> {
  const res = await authFetch('/api/media/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to upload from URL');
  return data;
}

export async function inspectMediaUrl(url: string): Promise<{
  url: string;
  valid: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
  error?: string;
}> {
  const res = await authFetch('/api/media/inspect-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'URL rejected');
  return data.probe;
}

export async function checkMediaUrls(urls: string[]): Promise<Array<{
  url: string;
  valid: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
  error?: string;
}>> {
  const res = await authFetch('/api/media/check-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to check URLs');
  return data.checks || [];
}

export async function batchDeleteMedia(ids: string[]): Promise<void> {
  const res = await authFetch('/api/media/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Batch delete failed');
}

export async function batchMoveFolder(ids: string[], folder: string): Promise<void> {
  const res = await authFetch('/api/media/batch-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, folder }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Batch move failed');
}

export async function bulkUploadUrls(payload: {
  urls: string[];
  visibility?: string;
  folder?: string;
}): Promise<{ success: boolean; media: MediaItem[]; errors: string[] }> {
  const res = await authFetch('/api/media/bulk-upload-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Bulk URL upload failed');
  return data;
}

// ==================== MASTER VERSIONS & HLS ====================

export async function fetchMediaVersions(mediaId: string): Promise<MediaVersionItem[]> {
  const res = await authFetch(`/api/media/${mediaId}/versions`);
  if (!res.ok) throw new Error('Failed to load versions');
  const data = await res.json();
  return data.versions || [];
}

export async function uploadNewMediaVersion(mediaId: string, formData: FormData): Promise<{ version: MediaVersionItem; job: ProcessingJobItem }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/media/${mediaId}/versions`, {
    method: 'POST',
    headers,
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to upload master version');
  return data;
}

export async function activateMediaVersion(mediaId: string, versionId: string): Promise<MediaItem> {
  const res = await authFetch(`/api/media/${mediaId}/versions/${versionId}/activate`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to activate version');
  return data.media;
}

export async function queueHlsPackaging(mediaId: string): Promise<{ job: ProcessingJobItem; deduplicated: boolean }> {
  const res = await authFetch(`/api/media/${mediaId}/package-hls`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to queue HLS job');
  return data;
}

// ==================== SUBTITLES STUDIO ====================

export async function uploadSubtitleFile(mediaId: string, formData: FormData): Promise<MediaItem> {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/media/${mediaId}/subtitles/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to upload subtitle');
  return data.media;
}

export async function updateSubtitleTrack(
  mediaId: string,
  trackIndex: number,
  updates: { isDefault?: boolean; isForced?: boolean; offsetMs?: number; title?: string }
): Promise<MediaItem> {
  const res = await authFetch(`/api/media/${mediaId}/subtitles/${trackIndex}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update subtitle settings');
  return data.media;
}

// ==================== AI STUDIO ====================

export async function fetchAiProviders(): Promise<AiProviderInfo[]> {
  const res = await authFetch('/api/ai/providers');
  if (!res.ok) return [];
  const data = await res.json();
  return data.providers || [];
}

export async function queueAiTranscribe(mediaId: string, payload: { provider?: string; language?: string }): Promise<ProcessingJobItem> {
  const res = await authFetch(`/api/media/${mediaId}/ai/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to queue transcription');
  return data.job;
}

export async function queueAiTranslate(
  mediaId: string,
  payload: { targetLanguage: string; targetCode: string; sourceTrackIndex?: number }
): Promise<ProcessingJobItem> {
  const res = await authFetch(`/api/media/${mediaId}/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to queue translation');
  return data.job;
}

export async function queueAiDetectChapters(mediaId: string): Promise<ProcessingJobItem> {
  const res = await authFetch(`/api/media/${mediaId}/ai/detect-chapters`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to queue intro/chapter detection');
  return data.job;
}

export async function fetchIntroSuggestions(mediaId: string): Promise<IntroSuggestionItem[]> {
  const res = await authFetch(`/api/media/${mediaId}/ai/suggestions`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.suggestions || [];
}

export async function approveIntroSuggestion(mediaId: string, suggestionId: string): Promise<MediaItem> {
  const res = await authFetch(`/api/media/${mediaId}/ai/suggestions/${suggestionId}/approve`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to approve suggestion');
  return data.media;
}

export async function rejectIntroSuggestion(mediaId: string, suggestionId: string): Promise<void> {
  const res = await authFetch(`/api/media/${mediaId}/ai/suggestions/${suggestionId}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to reject suggestion');
}

// ==================== QUEUE & WORKER MONITOR ====================

export async function fetchProcessingJobs(status = 'all', limit = 60): Promise<{ jobs: ProcessingJobItem[]; driver: string }> {
  const res = await authFetch(`/api/jobs?status=${encodeURIComponent(status)}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch processing queue');
  return res.json();
}

export async function cancelProcessingJob(jobId: string): Promise<void> {
  const res = await authFetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to cancel job');
}

export async function retryProcessingJob(jobId: string): Promise<void> {
  const res = await authFetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to retry job');
}

export async function replayDeadLetterJobs(): Promise<{ replayed: number }> {
  const res = await authFetch('/api/jobs/replay-dlq', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to replay DLQ');
  return data;
}

// ==================== SECURITY, RBAC, API KEYS, TELEMETRY ====================

export async function fetchSecurityAdmins(): Promise<{ admins: AdminUserItem[]; bootstrapAdminEmail: string }> {
  const res = await authFetch('/api/security/admins');
  if (!res.ok) throw new Error('Failed to load admins');
  return res.json();
}

export async function saveSecurityAdmin(payload: { uid: string; email: string; role: 'admin' | 'editor'; displayName?: string }): Promise<AdminUserItem> {
  const res = await authFetch('/api/security/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save admin');
  return data.admin;
}

export async function deleteSecurityAdmin(uid: string): Promise<void> {
  const res = await authFetch(`/api/security/admins/${uid}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to remove admin');
}

export async function fetchApiKeys(): Promise<ApiKeyItem[]> {
  const res = await authFetch('/api/security/api-keys');
  if (!res.ok) throw new Error('Failed to fetch API keys');
  const data = await res.json();
  return data.keys || [];
}

export async function createApiKey(payload: { name: string; role: 'admin' | 'editor' | 'playback'; scopes: string[] }): Promise<{ apiKey: ApiKeyItem; plaintextKey: string }> {
  const res = await authFetch('/api/security/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create API key');
  return data;
}

export async function revokeApiKeyById(id: string): Promise<void> {
  const res = await authFetch(`/api/security/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to revoke key');
}

export async function fetchAuditLogs(limit = 50): Promise<AuditLogItem[]> {
  const res = await authFetch(`/api/security/audit-logs?limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  const data = await res.json();
  return data.logs || [];
}

export async function fetchTelemetryReport(): Promise<any> {
  const res = await authFetch('/api/telemetry');
  if (!res.ok) throw new Error('Failed to fetch system telemetry');
  return res.json();
}

export function reportPlaybackTelemetry(mediaId: string, kind: 'playback_error' | 'playback_buffer', detail?: string): void {
  fetch('/api/telemetry/playback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId, kind, detail }),
  }).catch(() => {});
}

// ==================== ANALYTICS, REPORTS & SERIES ====================

export async function fetchAnalytics(mediaId?: string): Promise<any> {
  const url = mediaId && mediaId !== 'all' ? `/api/analytics?mediaId=${encodeURIComponent(mediaId)}` : '/api/analytics';
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Failed to fetch analytics');
  return res.json();
}

export async function recordMediaView(mediaId: string, mediaTitle?: string): Promise<any> {
  try {
    const res = await fetch('/api/analytics/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId, mediaTitle }),
    });
    return res.json();
  } catch {
    return null;
  }
}

export async function submitIssueReport(payload: {
  mediaId?: string;
  mediaTitle?: string;
  issueType: string;
  description?: string;
}): Promise<any> {
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to submit report');
  return data;
}

export async function fetchIssueReports(): Promise<any[]> {
  const res = await authFetch('/api/reports');
  if (!res.ok) throw new Error('Failed to fetch reports');
  return res.json();
}

export async function updateIssueReportStatus(id: string, status: string): Promise<any> {
  const res = await authFetch(`/api/reports/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update report');
  return data;
}

export async function deleteIssueReport(id: string): Promise<void> {
  const res = await authFetch(`/api/reports/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete report');
}

export async function searchIDDB(query: string, type: string = 'all'): Promise<any[]> {
  const res = await authFetch(`/api/series/iddb/search?q=${encodeURIComponent(query)}&type=${type}`);
  if (!res.ok) return [];
  return res.json();
}
