import { MediaItem, SystemStatus, StorageConfig } from '../types/media';

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Failed to fetch system status');
  return res.json();
}

export async function saveTelegramCredentials(apiId: number, apiHash: string): Promise<any> {
  const res = await fetch('/api/telegram/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiId, apiHash }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save credentials');
  return data;
}

export async function sendTelegramCode(phoneNumber: string): Promise<any> {
  const res = await fetch('/api/telegram/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send code');
  return data;
}

export async function verifyTelegramCode(code: string): Promise<{ success: boolean; requires2FA?: boolean }> {
  const res = await fetch('/api/telegram/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify code');
  return data;
}

export async function verifyTelegram2FA(password: string): Promise<{ success: boolean }> {
  const res = await fetch('/api/telegram/verify-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify 2FA password');
  return data;
}

export async function disconnectTelegram(): Promise<void> {
  const res = await fetch('/api/telegram/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to disconnect');
}

export async function reconnectTelegram(): Promise<any> {
  const res = await fetch('/api/telegram/reconnect', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to reconnect Telegram client');
  return data;
}

export async function testStorageChat(chatId: string): Promise<{ success: boolean; storage: StorageConfig }> {
  const res = await fetch('/api/storage/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to verify chat ID');
  return data;
}

export async function fetchMediaItems(): Promise<MediaItem[]> {
  const res = await fetch('/api/media');
  if (!res.ok) throw new Error('Failed to fetch media');
  return res.json();
}

export async function fetchMediaItem(id: string): Promise<MediaItem> {
  const res = await fetch(`/api/media/${id}`);
  if (!res.ok) throw new Error('Media not found');
  return res.json();
}

export async function updateMediaItem(id: string, updates: Partial<MediaItem>): Promise<MediaItem> {
  const res = await fetch(`/api/media/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update media');
  return data.media;
}

export async function deleteMediaItem(id: string): Promise<void> {
  const res = await fetch(`/api/media/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete media');
}

export async function uploadMediaFile(
  formData: FormData,
  onProgress?: (progress: number, statusText?: string) => void,
  onAbortRef?: { abort?: () => void }
): Promise<{ success: boolean; media: MediaItem }> {
  const file = formData.get('video') as File | null;
  const title = (formData.get('title') as string) || (file ? file.name : 'Untitled');
  const description = (formData.get('description') as string) || '';
  const visibility = (formData.get('visibility') as string) || 'public';
  const folder = (formData.get('folder') as string) || '';
  const introStart = formData.get('introStart') ? Number(formData.get('introStart')) : 0;
  const introEnd = formData.get('introEnd') ? Number(formData.get('introEnd')) : 0;
  const outroStart = formData.get('outroStart') ? Number(formData.get('outroStart')) : 0;
  const outroEnd = formData.get('outroEnd') ? Number(formData.get('outroEnd')) : 0;

  // Fallback if not a File instance
  if (!file || !(file instanceof File)) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
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

  // Resilient High-Speed Chunked Upload Engine: 2MB slices with concurrent workers
  // Bypasses all reverse proxy / Cloud Run payload limits (413 Payload Too Large)
  // and provides automatic retry with exponential backoff on transient network hiccups
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB optimal chunk size for fast transmission and low latency
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `up_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  let isAborted = false;
  const activeXhrs = new Set<XMLHttpRequest>();

  if (onAbortRef) {
    onAbortRef.abort = () => {
      isAborted = true;
      activeXhrs.forEach((xhr) => {
        try { xhr.abort(); } catch {}
      });
      activeXhrs.clear();
    };
  }

  // Track progress of every chunk for smooth, accurate overall progress
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

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);
      xhr.open('POST', '/api/media/upload-chunk');
      xhr.timeout = 90000; // 90 seconds timeout per chunk to comfortably handle slower network connections

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
        console.warn(`[Chunk Upload] Chunk ${chunkIndex + 1}/${totalChunks} failed (attempt ${attempt}/${maxRetries}):`, err?.message);
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

  // Run 2 concurrent upload workers in parallel (optimal throughput & rock-solid proxy stability)
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

  // Poll progress from server during assemble & Telegram MTProto upload
  let pollInterval: any = null;
  let serverReportedCompleteResult: any = null;

  const startPolling = () => {
    pollInterval = setInterval(async () => {
      if (isAborted) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const progRes = await fetch(`/api/media/upload-progress/${uploadId}`);
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
    const finishRes = await fetch('/api/media/upload-finish', {
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
      if (onProgress) onProgress(100, 'Upload complete! Media ready.');
      return finishData;
    }

    if (serverReportedCompleteResult) {
      if (onProgress) onProgress(100, 'Upload complete! Media ready.');
      return serverReportedCompleteResult;
    }

    const finishData = await finishRes.json().catch(() => ({}));
    throw new Error(finishData.error || 'Failed to finalize video upload on server');
  } catch (err: any) {
    clearInterval(pollInterval);
    if (serverReportedCompleteResult) {
      if (onProgress) onProgress(100, 'Upload complete! Media ready.');
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
}): Promise<{ success: boolean; media: MediaItem }> {
  const res = await fetch('/api/media/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to upload from URL');
  return data;
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
  const res = await fetch('/api/media/check-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to check URLs');
  return data.checks || [];
}

export async function batchDeleteMedia(ids: string[]): Promise<void> {
  const res = await fetch('/api/media/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Batch delete failed');
}

export async function batchMoveFolder(ids: string[], folder: string): Promise<void> {
  const res = await fetch('/api/media/batch-folder', {
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
  const res = await fetch('/api/media/bulk-upload-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Bulk URL upload failed');
  return data;
}

export async function fetchAnalytics(mediaId?: string): Promise<any> {
  const url = mediaId && mediaId !== 'all' ? `/api/analytics?mediaId=${encodeURIComponent(mediaId)}` : '/api/analytics';
  const res = await fetch(url);
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
  } catch (e) {
    // Silent fail for non-blocking analytics
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
  const res = await fetch('/api/reports');
  if (!res.ok) throw new Error('Failed to fetch reports');
  return res.json();
}

export async function updateIssueReportStatus(id: string, status: string): Promise<any> {
  const res = await fetch(`/api/reports/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update report');
  return data;
}

export async function deleteIssueReport(id: string): Promise<void> {
  const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete report');
}

export async function searchIDDB(query: string, type: string = 'all'): Promise<any[]> {
  const res = await fetch(`/api/series/iddb/search?q=${encodeURIComponent(query)}&type=${type}`);
  if (!res.ok) return [];
  return res.json();
}

