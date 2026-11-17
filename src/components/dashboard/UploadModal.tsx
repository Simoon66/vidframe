import React, { useState, useRef, useEffect } from 'react';
import { uploadMediaFile, uploadMediaUrl, bulkUploadUrls, checkMediaUrls, reconnectTelegram } from '../../services/api';
import { MediaItem, TelegramState, StorageConfig } from '../../types/media';
import { useToast } from '../common/Toast';
import { playUploadConfirmationSound } from '../../utils/confirmationSound';
import { isTranscodingNeeded, transcodeVideoFile } from '../../utils/videoTranscoder';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (media: MediaItem | MediaItem[]) => void;
  telegramState: TelegramState | null;
  storageConfig: StorageConfig | null;
  onGoToTelegram: () => void;
  onGoToStorage: () => void;
}

interface UrlCheckResult {
  url: string;
  valid: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
  error?: string;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  telegramState,
  storageConfig,
  onGoToTelegram,
  onGoToStorage,
}) => {
  const toast = useToast();

  // Exactly two modes: 'files' and 'url'
  const [activeTab, setActiveTab] = useState<'files' | 'url'>('files');

  // Files mode state (handles 1 or 20+ files seamlessly)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [customTitle, setCustomTitle] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // URL mode state (handles 1 or 20+ URLs seamlessly)
  const [urlInput, setUrlInput] = useState('');
  const [isCheckingUrls, setIsCheckingUrls] = useState(false);
  const [urlChecks, setUrlChecks] = useState<UrlCheckResult[]>([]);

  // Upload progress & performance state
  const [isUploading, setIsUploading] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [overallProgress, setOverallProgress] = useState(0);
  const [fileProgress, setFileProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadSpeed, setUploadSpeed] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const abortRef = useRef<{ abort?: () => void }>({});
  const lastLoadedRef = useRef<{ bytes: number; time: number }>({ bytes: 0, time: 0 });

  useEffect(() => {
    if (!isOpen) {
      // Reset state on close
      setSelectedFiles([]);
      setCustomTitle('');
      setUrlInput('');
      setUrlChecks([]);
      setErrorMessage(null);
      setIsUploading(false);
      setOverallProgress(0);
      setFileProgress(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const activeBackend = storageConfig?.backend || 'telegram';
  const isConnected = telegramState?.state === 'Connected';
  const isStorageReady =
    activeBackend === 'local_dev'
      ? true
      : activeBackend === 's3_r2'
      ? Boolean(storageConfig?.s3Configured)
      : Boolean(storageConfig?.chatId);
  const canUploadNow =
    activeBackend === 'local_dev' ||
    (activeBackend === 's3_r2' && Boolean(storageConfig?.s3Configured)) ||
    (activeBackend === 'telegram' && isConnected && isStorageReady);

  const handleFilesSelected = (filesList: FileList | null) => {
    if (!filesList || filesList.length === 0) return;
    const newFiles = Array.from(filesList);
    setSelectedFiles((prev) => {
      const merged = [...prev, ...newFiles];
      // Filter out duplicate files by name and size
      const unique = merged.filter(
        (file, idx, arr) => arr.findIndex((f) => f.name === file.name && f.size === file.size) === idx
      );
      return unique;
    });
    setErrorMessage(null);
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFilesSelected(e.dataTransfer.files);
    }
  };

  // URL Checker
  const handleCheckUrls = async () => {
    const urls = urlInput
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      setErrorMessage('Please paste at least one video URL to check.');
      return;
    }

    setIsCheckingUrls(true);
    setErrorMessage(null);

    try {
      const checks = await checkMediaUrls(urls);
      setUrlChecks(checks);
      const validCount = checks.filter((c) => c.valid).length;
      if (validCount === urls.length) {
        toast.success(`All ${validCount} URL(s) verified and ready to download!`, 'URLs Verified');
      } else {
        toast.warning(
          `${validCount} of ${urls.length} URLs verified. Some links could not be reached.`,
          'URL Check Results'
        );
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to verify URLs');
      toast.error(err.message || 'Verification failed', 'URL Check Error');
    } finally {
      setIsCheckingUrls(false);
    }
  };

  const handleCancelUpload = () => {
    if (abortRef.current.abort) {
      abortRef.current.abort();
    }
    setIsUploading(false);
    setOverallProgress(0);
    setFileProgress(0);
    setUploadStatus('Upload cancelled.');
    setUploadSpeed('');
    toast.warning('File upload was cancelled.', 'Upload Cancelled');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (activeBackend === 'telegram' && !isConnected) {
      setErrorMessage('Telegram is not connected. Please connect Telegram or switch storage adapter in Settings.');
      return;
    }

    if (!canUploadNow) {
      setErrorMessage(
        activeBackend === 's3_r2'
          ? 'S3 / R2 bucket is not configured yet. Configure credentials in Storage Settings.'
          : 'Storage channel is not configured. Please enter a valid Telegram channel ID or switch backend.'
      );
      return;
    }

    setErrorMessage(null);

    // ===========================
    // MODE 1: FILES UPLOAD (1 or 20+ files)
    // ===========================
    if (activeTab === 'files') {
      if (selectedFiles.length === 0) {
        setErrorMessage('Please select or drag at least one video file (MKV, MP4, etc.).');
        return;
      }

      setIsUploading(true);
      const uploadedResults: MediaItem[] = [];
      const totalFiles = selectedFiles.length;

      try {
        for (let i = 0; i < totalFiles; i++) {
          const currentFile = selectedFiles[i];
          setCurrentFileIndex(i + 1);
          setCurrentFileName(currentFile.name);
          setFileProgress(0);
          setUploadSpeed('');

          let fileToUpload = currentFile;
          if (isTranscodingNeeded(currentFile)) {
            setUploadStatus(`Converting ${currentFile.name} to streamable MP4 (H.264/AAC)...`);
            try {
              const transcodeResult = await transcodeVideoFile(currentFile, (progress) => {
                setUploadStatus(progress.statusText);
                setFileProgress(Math.round(progress.percent * 0.4));
                const overall = Math.round(((i + (progress.percent * 0.4) / 100) / totalFiles) * 100);
                setOverallProgress(overall);
              });
              if (transcodeResult.converted) {
                fileToUpload = transcodeResult.file;
                setCurrentFileName(fileToUpload.name);
              }
            } catch (transcodeErr) {
              console.warn('[UploadModal] Transcode step skipped, proceeding with upload:', transcodeErr);
            }
          }

          setUploadStatus(
            totalFiles === 1
              ? `Uploading ${fileToUpload.name} (High-Speed Multi-Worker Chunks)...`
              : `Uploading file ${i + 1} of ${totalFiles}: ${fileToUpload.name}...`
          );

          const formData = new FormData();
          formData.append('video', fileToUpload);
          const title = totalFiles === 1 && customTitle.trim()
            ? customTitle.trim()
            : currentFile.name.replace(/\.[^/.]+$/, '');
          formData.append('title', title);

          lastLoadedRef.current = { bytes: 0, time: Date.now() };

          const res = await uploadMediaFile(
            formData,
            (percent, customStatus) => {
              setFileProgress(percent);
              const overall = Math.round(((i + percent / 100) / totalFiles) * 100);
              setOverallProgress(overall);

              if (customStatus) {
                setUploadStatus(customStatus);
              } else if (percent >= 88) {
                setUploadStatus(`Finalizing & saving ${fileToUpload.name} to Telegram cloud...`);
              }

              // Calculate real-time throughput speed
              const now = Date.now();
              const elapsedSec = (now - lastLoadedRef.current.time) / 1000;
              if (elapsedSec > 0.8) {
                const currentBytes = (percent / 100) * fileToUpload.size;
                const bytesDiff = currentBytes - lastLoadedRef.current.bytes;
                if (bytesDiff > 0) {
                  const mbPerSec = (bytesDiff / (1024 * 1024 * elapsedSec)).toFixed(1);
                  setUploadSpeed(`${mbPerSec} MB/s`);
                }
                lastLoadedRef.current = { bytes: currentBytes, time: now };
              }
            },
            abortRef.current
          );

          uploadedResults.push(res.media);
          if (res.duplicateWarning) {
            toast.warning(
              `Exact SHA-256 content already exists ("${res.duplicateWarning.title}"). Uploaded as a separate media item.`,
              'Duplicate Content Detected'
            );
          }
        }

        setIsUploading(false);
        playUploadConfirmationSound();
        toast.success(
          totalFiles === 1
            ? `Successfully uploaded "${uploadedResults[0].title}"! Async HLS packaging queued.`
            : `Successfully uploaded ${uploadedResults.length} videos! HLS packaging queued.`,
          'Upload Complete'
        );
        onSuccess(totalFiles === 1 ? uploadedResults[0] : uploadedResults);
        onClose();
      } catch (err: any) {
        setIsUploading(false);
        const msg = err.message || 'Upload failed.';
        setErrorMessage(msg);
        if (msg.includes('cancelled')) {
          toast.warning('Upload was cancelled.', 'Cancelled');
        } else {
          toast.error(msg, 'Upload Failed');
        }
      }
    }

    // ===========================
    // MODE 2: URL UPLOAD (1 or 20+ URLs)
    // ===========================
    if (activeTab === 'url') {
      const urls = urlInput
        .split('\n')
        .map((u) => u.trim())
        .filter(Boolean);

      if (urls.length === 0) {
        setErrorMessage('Please enter at least one valid video download URL.');
        return;
      }

      setIsUploading(true);
      setOverallProgress(15);
      setUploadStatus(
        urls.length === 1
          ? 'Checking and streaming video from URL to Telegram cloud...'
          : `Streaming and uploading ${urls.length} video URLs directly...`
      );

      try {
        if (urls.length === 1) {
          const singleUrl = urls[0];
          setOverallProgress(35);
          const res = await uploadMediaUrl({
            url: singleUrl,
            title: customTitle.trim() || undefined,
          });
          setOverallProgress(100);
          setIsUploading(false);
          playUploadConfirmationSound();
          if (res.duplicateWarning) {
            toast.warning(
              `Duplicate SHA-256 detected ("${res.duplicateWarning.title}"). Created new asset anyway.`,
              'Duplicate Content'
            );
          }
          toast.success(`Successfully imported "${res.media.title}"! HLS packaging queued.`, 'Upload Complete');
          onSuccess(res.media);
          onClose();
        } else {
          setOverallProgress(30);
          const res = await bulkUploadUrls({ urls });
          setOverallProgress(100);
          setIsUploading(false);
          playUploadConfirmationSound();

          if (res.errors && res.errors.length > 0) {
            toast.warning(
              `Uploaded ${res.media.length} videos. ${res.errors.length} failed.`,
              'Upload Partial'
            );
          } else {
            toast.success(`Successfully imported all ${res.media.length} videos from URLs!`, 'Upload Complete');
          }

          onSuccess(res.media);
          onClose();
        }
      } catch (err: any) {
        setIsUploading(false);
        const msg = err.message || 'Failed to download and upload from URL.';
        setErrorMessage(msg);
        toast.error(msg, 'URL Upload Failed');
      }
    }
  };

  const totalSelectedBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
  const formattedTotalSize =
    totalSelectedBytes > 1024 * 1024 * 1024
      ? `${(totalSelectedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
      : `${(totalSelectedBytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div
        className="relative w-full max-w-xl bg-zinc-950 border border-zinc-800 rounded-3xl p-6 sm:p-7 shadow-2xl my-8 text-zinc-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 shadow-lg shadow-red-950/40">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Upload Video to Telegram</h3>
              <p className="text-[11px] text-zinc-400">High-speed chunk streaming • MKV, MP4 & WebM support</p>
            </div>
          </div>
          <button
            onClick={isUploading ? handleCancelUpload : onClose}
            className="p-1.5 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            aria-label="Close upload modal"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* 2 Systems Tab Selector: File Upload vs URL Upload */}
        {!isUploading && (
          <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-900/90 rounded-2xl mb-5 border border-zinc-800/70 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setActiveTab('files')}
              className={`py-2 px-3 rounded-xl transition flex items-center justify-center gap-2 cursor-pointer ${
                activeTab === 'files'
                  ? 'bg-red-600 text-white shadow-lg shadow-red-950'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
              <span>File Upload (1 or 20+ Files)</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('url')}
              className={`py-2 px-3 rounded-xl transition flex items-center justify-center gap-2 cursor-pointer ${
                activeTab === 'url'
                  ? 'bg-red-600 text-white shadow-lg shadow-red-950'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span>URL Upload (1 or 20+ Links)</span>
            </button>
          </div>
        )}

        {/* Storage backend readiness warning */}
        {!canUploadNow && (
          <div className="mb-5 p-4 bg-amber-950/40 border border-amber-500/30 rounded-2xl text-xs space-y-2">
            <p className="text-amber-200 font-semibold flex items-center gap-1.5">
              <span>⚠️</span>
              <span>Storage Backend Configuration Required ({activeBackend})</span>
            </p>
            {activeBackend === 'telegram' && !isConnected && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-amber-300/80">Telegram account not connected.</span>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onGoToTelegram();
                  }}
                  className="px-3 py-1 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 rounded-lg font-semibold transition cursor-pointer"
                >
                  Open Settings
                </button>
              </div>
            )}
            {((activeBackend === 'telegram' && isConnected && !isStorageReady) || activeBackend === 's3_r2') && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-amber-300/80">
                  {activeBackend === 's3_r2' ? 'S3 / R2 credentials not verified.' : 'Telegram storage channel ID not set.'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onGoToStorage();
                  }}
                  className="px-3 py-1 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 rounded-lg font-semibold transition cursor-pointer"
                >
                  Configure Storage
                </button>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* TAB 1: FILE UPLOAD */}
          {activeTab === 'files' && (
            <div className="space-y-3">
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center cursor-pointer transition-all ${
                  isDragging
                    ? 'border-red-500 bg-red-950/20 scale-[0.99]'
                    : 'border-zinc-800 hover:border-zinc-600 bg-zinc-900/40 hover:bg-zinc-900/70'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,.mkv,.mp4,.webm,.avi,.mov,.flv,.ts"
                  multiple
                  onChange={(e) => handleFilesSelected(e.target.files)}
                  className="hidden"
                />
                <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center mx-auto text-zinc-300 mb-3 group-hover:scale-105 transition">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                </div>
                <div className="text-sm font-semibold text-white mb-1">
                  Click or drag & drop video files here
                </div>
                <p className="text-zinc-500 text-[11px] mb-2">
                  Select 1 file or up to 20+ files at once • MKV, MP4, WebM (Any file size)
                </p>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/70 rounded-full text-[10px] text-zinc-400 font-mono">
                  <span>⚡ Multi-worker 8MB parallel chunk streaming</span>
                </div>
              </div>

              {/* Selected Files List */}
              {selectedFiles.length > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-white">
                      Selected Videos ({selectedFiles.length})
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-red-400 font-mono font-medium">{formattedTotalSize}</span>
                      <button
                        type="button"
                        onClick={() => setSelectedFiles([])}
                        className="text-zinc-500 hover:text-red-400 transition cursor-pointer text-[11px]"
                      >
                        Clear All
                      </button>
                    </div>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                    {selectedFiles.map((f, idx) => {
                      const isMkv = f.name.toLowerCase().endsWith('.mkv');
                      const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
                      return (
                        <div
                          key={`${f.name}-${idx}`}
                          className="flex items-center justify-between p-2.5 bg-zinc-900/70 border border-zinc-800/80 rounded-xl"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-zinc-500 font-mono text-[10px] w-4">{idx + 1}.</span>
                            <div className="truncate font-medium text-zinc-200 text-xs">
                              {f.name}
                            </div>
                            {isMkv && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[9px] font-bold shrink-0">
                                MKV
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 shrink-0 ml-2">
                            <span className="text-zinc-400 font-mono text-[11px]">{sizeMb} MB</span>
                            <button
                              type="button"
                              onClick={() => removeFile(idx)}
                              className="text-zinc-500 hover:text-red-400 transition cursor-pointer p-0.5"
                              aria-label="Remove file"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Single File Title input */}
              {selectedFiles.length === 1 && (
                <div>
                  <label className="block text-zinc-400 font-medium mb-1">Custom Title (Optional)</label>
                  <input
                    type="text"
                    placeholder={selectedFiles[0].name.replace(/\.[^/.]+$/, '')}
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
                  />
                </div>
              )}
            </div>
          )}

          {/* TAB 2: URL UPLOAD */}
          {activeTab === 'url' && (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-zinc-400 font-medium">
                    Video Direct Download Link(s) (1 or 20+ URLs, one per line)
                  </label>
                  <button
                    type="button"
                    onClick={handleCheckUrls}
                    disabled={isCheckingUrls || !urlInput.trim()}
                    className="text-[11px] text-red-400 hover:text-red-300 font-semibold cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
                  >
                    {isCheckingUrls ? (
                      <>
                        <div className="w-3 h-3 rounded-full border-2 border-red-400/30 border-t-red-400 animate-spin" />
                        <span>Checking URLs...</span>
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        <span>Check Download URLs</span>
                      </>
                    )}
                  </button>
                </div>
                <textarea
                  rows={4}
                  placeholder="https://example.com/movie.mkv&#10;https://example.com/episode2.mp4"
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setUrlChecks([]);
                  }}
                  className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-2xl text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition font-mono text-[11px] resize-none"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Supports direct HTTP/HTTPS video links. Checks accessibility and file headers before streaming to Telegram.
                </p>
              </div>

              {/* URL Check Verification Statuses */}
              {urlChecks.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-[11px] font-semibold text-zinc-300">
                    URL Validation Results ({urlChecks.filter((c) => c.valid).length}/{urlChecks.length} Working)
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                    {urlChecks.map((item, idx) => (
                      <div
                        key={idx}
                        className={`p-2 rounded-xl border flex items-center justify-between text-[11px] ${
                          item.valid
                            ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                            : 'bg-red-950/30 border-red-500/30 text-red-300'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate pr-2">
                          <span>{item.valid ? '✅' : '❌'}</span>
                          <span className="font-mono truncate">{item.fileName || item.url}</span>
                        </div>
                        <div className="shrink-0 font-mono text-[10px]">
                          {item.valid ? (
                            <span>
                              {item.contentLength
                                ? `${(item.contentLength / (1024 * 1024)).toFixed(1)} MB`
                                : 'Ready'}
                            </span>
                          ) : (
                            <span className="text-red-400">{item.error || 'Unreachable'}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Single URL optional title */}
              {!urlInput.includes('\n') && urlInput.trim() && (
                <div>
                  <label className="block text-zinc-400 font-medium mb-1">Custom Title (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. My Favorite Movie"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
                  />
                </div>
              )}
            </div>
          )}

          {/* Upload Progress Overlay */}
          {isUploading && (
            <div className="space-y-2.5 p-4 bg-zinc-900/90 border border-zinc-800 rounded-2xl">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-200 font-semibold truncate pr-2">{uploadStatus}</span>
                <span className="text-red-400 font-mono font-bold text-sm">{overallProgress}%</span>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden p-0.5">
                <div
                  className="h-full bg-gradient-to-r from-red-600 to-amber-500 rounded-full transition-all duration-200"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>

              {/* Performance Stats */}
              <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-0.5 font-mono">
                <span>
                  {activeTab === 'files' && selectedFiles.length > 1
                    ? `File ${currentFileIndex} of ${selectedFiles.length} (${fileProgress}%)`
                    : currentFileName}
                </span>
                {uploadSpeed && <span className="text-emerald-400 font-bold">{uploadSpeed}</span>}
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={handleCancelUpload}
                  className="px-3 py-1 bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
                >
                  Cancel Upload
                </button>
              </div>
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="p-3.5 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300 text-xs space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-base shrink-0">⚠️</span>
                <span className="flex-1 font-medium">{errorMessage}</span>
              </div>
              {(errorMessage.includes('Not connected') ||
                errorMessage.includes('disconnected') ||
                errorMessage.includes('connect') ||
                errorMessage.includes('Telegram') ||
                errorMessage.includes('Network')) && (
                <div className="flex items-center gap-2 pt-1 border-t border-red-900/40">
                  <button
                    type="button"
                    disabled={isReconnecting}
                    onClick={async () => {
                      setIsReconnecting(true);
                      try {
                        await reconnectTelegram();
                        setErrorMessage(null);
                        toast.success('Telegram client reconnected successfully! You can resume upload.', 'Reconnected');
                      } catch (err: any) {
                        toast.error(err.message || 'Reconnection failed', 'Reconnect Error');
                      } finally {
                        setIsReconnecting(false);
                      }
                    }}
                    className="px-3 py-1 bg-red-900/60 hover:bg-red-800 text-white rounded-lg font-semibold transition cursor-pointer flex items-center gap-1.5"
                  >
                    <span>🔄</span>
                    <span>{isReconnecting ? 'Reconnecting Socket...' : 'Reconnect Telegram Now'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onGoToTelegram();
                    }}
                    className="px-2.5 py-1 text-zinc-400 hover:text-white transition underline cursor-pointer"
                  >
                    Open Telegram Settings
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={onClose}
              disabled={isUploading}
              className="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl transition cursor-pointer font-medium disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={
                isUploading ||
                (activeTab === 'files' && selectedFiles.length === 0) ||
                (activeTab === 'url' && !urlInput.trim())
              }
              className="px-6 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold shadow-lg shadow-red-950/50 transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-2"
            >
              {isUploading ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Processing Upload ({activeBackend})...</span>
                </>
              ) : (
                <span>
                  {activeTab === 'files'
                    ? selectedFiles.length > 1
                      ? `Start Upload (${selectedFiles.length} Files)`
                      : 'Start Upload'
                    : 'Download & Upload URL'}
                </span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
