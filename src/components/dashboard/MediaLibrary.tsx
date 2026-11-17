import React, { useState, useMemo } from 'react';
import { MediaItem } from '../../types/media';
import { batchDeleteMedia, batchMoveFolder } from '../../services/api';
import { useToast } from '../common/Toast';

interface MediaLibraryProps {
  mediaItems: MediaItem[];
  isLoading: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRefresh: () => void;
  onOpenUpload: () => void;
  onOpenEdit: (item: MediaItem) => void;
  onOpenPreview: (item: MediaItem) => void;
  onDeleteMedia: (id: string) => void;
  folders: string[];
  onBatchUpdated: () => void;
}

export const MediaLibrary: React.FC<MediaLibraryProps> = ({
  mediaItems,
  isLoading,
  isLoadingMore = false,
  hasMore = false,
  onLoadMore,
  onRefresh,
  onOpenUpload,
  onOpenEdit,
  onOpenPreview,
  onDeleteMedia,
  folders,
  onBatchUpdated,
}) => {
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterVisibility, setFilterVisibility] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedFolderFilter, setSelectedFolderFilter] = useState<string>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveToFolderInput, setMoveToFolderInput] = useState('');
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false);
  const [isBatchActionRunning, setIsBatchActionRunning] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedType, setCopiedType] = useState<'embed' | 'watch' | 'iframe' | null>(null);

  const filteredItems = useMemo(() => {
    return mediaItems.filter((item) => {
      const matchesSearch =
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.filename.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesVis = filterVisibility === 'all' || item.visibility === filterVisibility;
      const matchesStatus = filterStatus === 'all' || item.processingStatus === filterStatus;
      const matchesFolder =
        selectedFolderFilter === 'all'
          ? true
          : selectedFolderFilter === 'unfiled'
          ? !item.folder
          : item.folder === selectedFolderFilter;
      return matchesSearch && matchesVis && matchesStatus && matchesFolder;
    });
  }, [mediaItems, searchQuery, filterVisibility, filterStatus, selectedFolderFilter]);

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((i) => i.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const executeBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsBatchActionRunning(true);
    setShowBatchDeleteModal(false);
    const count = selectedIds.size;
    try {
      await batchDeleteMedia(Array.from(selectedIds));
      setSelectedIds(new Set());
      toast.success(
        `Successfully deleted ${count} selected video${count > 1 ? 's' : ''}!`,
        'Batch Deleted'
      );
      onBatchUpdated();
    } catch (e: any) {
      toast.error(e.message || 'Batch delete failed', 'Delete Failed');
    } finally {
      setIsBatchActionRunning(false);
    }
  };

  const handleBatchMove = async (targetFolder: string) => {
    if (selectedIds.size === 0) return;
    setIsBatchActionRunning(true);
    const count = selectedIds.size;
    try {
      await batchMoveFolder(Array.from(selectedIds), targetFolder.trim());
      setSelectedIds(new Set());
      setShowMoveModal(false);
      setMoveToFolderInput('');
      toast.success(
        `Moved ${count} video${count > 1 ? 's' : ''} to "${targetFolder || 'Library Root'}"!`,
        'Folder Updated'
      );
      onBatchUpdated();
    } catch (e: any) {
      toast.error(e.message || 'Batch move failed', 'Move Failed');
    } finally {
      setIsBatchActionRunning(false);
    }
  };

  const copyToClipboard = (text: string, id: string, type: 'embed' | 'watch' | 'iframe') => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setCopiedType(type);
    setTimeout(() => {
      setCopiedId(null);
      setCopiedType(null);
    }, 2000);
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const formatDuration = (secs?: number): string => {
    if (!secs) return '--:--';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const appOrigin = window.location.origin;

  return (
    <div className="space-y-6">
      {/* Top Controls: Search, Folder Tabs, Visibility Filter, Refresh, Upload */}
      <div className="flex flex-col gap-3">
        {/* Folders Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-none">
          <button
            onClick={() => setSelectedFolderFilter('all')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              selectedFolderFilter === 'all'
                ? 'bg-red-600 text-white shadow'
                : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            All Folders ({mediaItems.length})
          </button>
          <button
            onClick={() => setSelectedFolderFilter('unfiled')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
              selectedFolderFilter === 'unfiled'
                ? 'bg-red-600 text-white shadow'
                : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            Unfiled ({mediaItems.filter((i) => !i.folder).length})
          </button>
          {folders.map((folder) => (
            <button
              key={folder}
              onClick={() => setSelectedFolderFilter(folder)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition cursor-pointer flex items-center gap-1.5 ${
                selectedFolderFilter === folder
                  ? 'bg-red-600 text-white shadow'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
              }`}
            >
              <span>📁</span>
              <span>{folder}</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/30">
                {mediaItems.filter((i) => i.folder === folder).length}
              </span>
            </button>
          ))}
        </div>

        {/* Search & Action Bar */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
          <div className="relative flex-1 max-w-md">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search media by title or filename..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-zinc-900/90 border border-zinc-800 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
            {/* Multi-select check all */}
            <button
              onClick={toggleSelectAll}
              className="px-3 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-xl text-xs font-medium transition cursor-pointer whitespace-nowrap"
            >
              {selectedIds.size === filteredItems.length && filteredItems.length > 0 ? 'Deselect All' : 'Select All'}
            </button>

            <select
              value={filterVisibility}
              onChange={(e) => setFilterVisibility(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-red-500/80 transition cursor-pointer"
            >
              <option value="all">All Visibility</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-red-500/80 transition cursor-pointer"
            >
              <option value="all">All Status</option>
              <option value="ready">Ready</option>
              <option value="processing">Processing</option>
              <option value="failed">Failed</option>
            </select>

            <button
              onClick={onRefresh}
              className="p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white rounded-xl transition cursor-pointer"
              title="Refresh media list"
              aria-label="Refresh media list"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={isLoading ? 'animate-spin' : ''}
              >
                <path d="M21 2v6h-6" />
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            </button>
          </div>
        </div>

        {/* Batch Actions Toolbar (Appears when items are selected) */}
        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between p-3 bg-red-950/40 border border-red-500/40 rounded-2xl animate-in fade-in text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="font-bold text-white">{selectedIds.size} videos selected</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowMoveModal(true)}
                disabled={isBatchActionRunning}
                className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl font-medium transition cursor-pointer"
              >
                Move to Folder...
              </button>
              <button
                onClick={() => setShowBatchDeleteModal(true)}
                disabled={isBatchActionRunning}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold shadow transition cursor-pointer"
              >
                {isBatchActionRunning ? 'Deleting...' : 'Delete Selected'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Media Cards Grid */}
      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center text-zinc-500">
          <div className="w-8 h-8 rounded-full border-2 border-red-600/30 border-t-red-500 animate-spin mb-3" />
          <p className="text-xs">Loading media records from Firestore...</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="py-20 border border-dashed border-zinc-800/80 rounded-2xl flex flex-col items-center justify-center text-center p-6 bg-zinc-950/40">
          <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600 mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
              <line x1="7" y1="2" x2="7" y2="22" />
              <line x1="17" y1="2" x2="17" y2="22" />
              <line x1="2" y1="12" x2="22" y2="12" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-white mb-1">
            {searchQuery ? 'No matching videos found' : 'Your video library is empty'}
          </h3>
          <p className="text-xs text-zinc-400 max-w-sm mb-5">
            {searchQuery
              ? 'Try modifying your search keywords or folder filter.'
              : 'Upload or bulk upload high-performance videos streamable directly via Telegram MTProto.'}
          </p>
          {!searchQuery && (
            <button
              onClick={onOpenUpload}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-xl shadow-md transition active:scale-95 cursor-pointer"
            >
              Upload Video Now
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredItems.map((item) => {
            const isSelected = selectedIds.has(item.id);
            const embedUrl = `${appOrigin}/embed/${item.id}`;
            const watchUrl = `${appOrigin}/watch/${item.id}`;
            const iframeCode = `<iframe src="${embedUrl}" title="${item.title}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" frameborder="0"></iframe>`;

            const hasIntro = item.introStart !== undefined && item.introEnd !== undefined && item.introEnd > item.introStart;
            const hasOutro = item.outroStart !== undefined && item.outroEnd !== undefined && item.outroEnd > item.outroStart;

            return (
              <div
                key={item.id}
                className={`group relative flex flex-col justify-between bg-zinc-900/60 hover:bg-zinc-900/90 border rounded-2xl p-4 transition-all duration-200 shadow-lg ${
                  isSelected ? 'border-red-500 bg-red-950/20' : 'border-zinc-800/80 hover:border-zinc-700/80'
                }`}
              >
                {/* Checkbox for Multi-select */}
                <div className="absolute top-3 right-3 z-10">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelectOne(item.id)}
                    className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-red-600 focus:ring-red-500 cursor-pointer"
                  />
                </div>

                <div>
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-8 mb-2">
                    <h4
                      onClick={() => onOpenPreview(item)}
                      className="text-sm font-semibold text-white group-hover:text-red-400 transition cursor-pointer line-clamp-1"
                      title={item.title}
                    >
                      {item.title}
                    </h4>
                  </div>

                  {/* Folder, HLS & Status Badges */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-2">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-mono font-semibold border ${
                        item.visibility === 'public'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : item.visibility === 'unlisted'
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {item.visibility}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-mono border ${
                        item.playbackMode === 'hls_v2'
                          ? 'bg-red-500/10 text-red-300 border-red-500/30'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {item.playbackMode === 'hls_v2' ? 'HLS ABR' : item.storageBackend || 'telegram'}
                    </span>
                    {item.processingStatus !== 'ready' && (
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-mono border ${
                          item.processingStatus === 'processing'
                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                            : 'bg-red-500/10 text-red-400 border-red-500/30'
                        }`}
                      >
                        {item.processingStatus}
                      </span>
                    )}
                    {item.folder && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                        📁 {item.folder}
                      </span>
                    )}
                  </div>

                  {/* Filename & Tech details */}
                  <div className="text-[11px] text-zinc-400 space-y-1 mb-3">
                    <p className="truncate font-mono text-zinc-500" title={item.filename}>
                      {item.filename}
                    </p>
                    <div className="flex items-center gap-2.5 text-zinc-400 font-mono text-[10px]">
                      <span>{formatFileSize(item.size)}</span>
                      <span>•</span>
                      <span>{formatDuration(item.duration)}</span>
                      <span>•</span>
                      <span className="uppercase">{item.mimeType.split('/')[1] || 'video'}</span>
                      {item.sha256Hash && (
                        <>
                          <span>•</span>
                          <span title={item.sha256Hash}>sha256:{item.sha256Hash.slice(0, 8)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Intro / Outro Skip Badges */}
                  {(hasIntro || hasOutro) && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {hasIntro && (
                        <span className="text-[10px] px-2 py-0.5 bg-red-950/40 border border-red-500/30 text-red-300 rounded-md font-mono">
                          Intro: {item.introStart}s–{item.introEnd}s
                        </span>
                      )}
                      {hasOutro && (
                        <span className="text-[10px] px-2 py-0.5 bg-red-950/40 border border-red-500/30 text-red-300 rounded-md font-mono">
                          Outro: {item.outroStart}s–{item.outroEnd}s
                        </span>
                      )}
                    </div>
                  )}

                  {item.description && (
                    <p className="text-xs text-zinc-400 line-clamp-2 mb-3">
                      {item.description}
                    </p>
                  )}
                </div>

                {/* Card Actions Footer */}
                <div className="pt-3 border-t border-zinc-800/80 space-y-2">
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      onClick={() => copyToClipboard(embedUrl, item.id, 'embed')}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-[11px] font-medium transition cursor-pointer text-center truncate border border-zinc-700/60"
                      title="Copy Embed URL"
                    >
                      {copiedId === item.id && copiedType === 'embed' ? '✓ Copied!' : 'Copy Embed'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(iframeCode, item.id, 'iframe')}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-[11px] font-medium transition cursor-pointer text-center truncate border border-zinc-700/60"
                      title="Copy <iframe> snippet"
                    >
                      {copiedId === item.id && copiedType === 'iframe' ? '✓ Copied!' : 'Copy Code'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(watchUrl, item.id, 'watch')}
                      className="px-2 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-[11px] font-medium transition cursor-pointer text-center truncate border border-zinc-700/60"
                      title="Copy Watch URL"
                    >
                      {copiedId === item.id && copiedType === 'watch' ? '✓ Copied!' : 'Watch URL'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      onClick={() => onOpenPreview(item)}
                      className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5 border border-zinc-700"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      <span>Player</span>
                    </button>

                    <button
                      onClick={() => onOpenEdit(item)}
                      className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-lg transition cursor-pointer border border-zinc-700"
                      title="Edit metadata & Skip times"
                      aria-label="Edit metadata"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>

                    <button
                      onClick={() => setConfirmDeleteId(item.id)}
                      className="p-1.5 bg-zinc-800 hover:bg-red-950/60 text-zinc-400 hover:text-red-400 rounded-lg transition cursor-pointer border border-zinc-700 hover:border-red-900/60"
                      title="Delete video record"
                      aria-label="Delete video"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Cursor Pagination Footer */}
      {hasMore && onLoadMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="px-6 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
          >
            {isLoadingMore ? (
              <>
                <div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-400/30 border-t-white animate-spin" />
                <span>Loading next page...</span>
              </>
            ) : (
              <span>Load More Videos</span>
            )}
          </button>
        </div>
      )}

      {/* Move to Folder Modal */}
      {showMoveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-2xl p-6 text-zinc-300 shadow-2xl space-y-4">
            <h3 className="text-sm font-bold text-white">Move {selectedIds.size} Videos to Folder</h3>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Target Folder Name</label>
              <input
                type="text"
                placeholder="e.g. Anime / Movies"
                list="modal-folders"
                value={moveToFolderInput}
                onChange={(e) => setMoveToFolderInput(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white text-xs focus:outline-none focus:border-red-500"
              />
              <datalist id="modal-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowMoveModal(false)}
                className="px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-xs"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBatchMove(moveToFolderInput)}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold"
              >
                Move Videos
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app Video Delete Confirmation Modal */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 mx-auto">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </div>
            <div className="text-center space-y-1">
              <h3 className="text-base font-bold text-white">Delete Video</h3>
              <p className="text-xs text-zinc-400">
                Are you sure you want to delete this video? This action is permanent.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold border border-zinc-700/60 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const idToDelete = confirmDeleteId;
                  setConfirmDeleteId(null);
                  onDeleteMedia(idToDelete);
                }}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/40 transition cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* In-app Batch Delete Confirmation Modal */}
      {showBatchDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 mx-auto">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </div>
            <div className="text-center space-y-1">
              <h3 className="text-base font-bold text-white">Delete Selected Videos</h3>
              <p className="text-xs text-zinc-400">
                Are you sure you want to delete <strong className="text-white">{selectedIds.size}</strong> selected videos? This action is permanent.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setShowBatchDeleteModal(false)}
                className="flex-1 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold border border-zinc-700/60 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={executeBatchDelete}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/40 transition cursor-pointer"
              >
                Delete ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
