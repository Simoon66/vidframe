import React, { useState, useEffect, useCallback } from 'react';
import {
  MediaItem,
  MediaVersionItem,
  IntroSuggestionItem,
  AiProviderInfo,
  ChapterItem,
} from '../../types/media';
import {
  updateMediaItem,
  fetchMediaVersions,
  uploadNewMediaVersion,
  activateMediaVersion,
  queueHlsPackaging,
  uploadSubtitleFile,
  updateSubtitleTrack,
  fetchAiProviders,
  queueAiTranscribe,
  queueAiTranslate,
  queueAiDetectChapters,
  fetchIntroSuggestions,
  approveIntroSuggestion,
  rejectIntroSuggestion,
  mintSignedPlaybackGrant,
} from '../../services/api';
import { useToast } from '../common/Toast';

interface EditMediaModalProps {
  media: MediaItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (updated: MediaItem) => void;
}

type StudioTab = 'metadata' | 'versions' | 'subtitles' | 'ai';

export const EditMediaModal: React.FC<EditMediaModalProps> = ({
  media,
  isOpen,
  onClose,
  onSaved,
}) => {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<StudioTab>('metadata');

  const formatSeconds = (sec?: number): string => {
    if (sec === undefined || sec === null || isNaN(sec) || sec <= 0) return '';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const parseTimestamp = (str: string): number => {
    if (!str.trim()) return 0;
    const parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  };

  const [title, setTitle] = useState(media?.title || '');
  const [description, setDescription] = useState(media?.description || '');
  const [folder, setFolder] = useState(media?.folder || '');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>(media?.visibility || 'public');
  const [allowedDomainsText, setAllowedDomainsText] = useState((media?.allowedDomains || []).join(', '));
  const [requireSignedPlayback, setRequireSignedPlayback] = useState(Boolean(media?.requireSignedPlayback));
  const [introStart, setIntroStart] = useState(formatSeconds(media?.introStart));
  const [introEnd, setIntroEnd] = useState(formatSeconds(media?.introEnd));
  const [outroStart, setOutroStart] = useState(formatSeconds(media?.outroStart));
  const [outroEnd, setOutroEnd] = useState(formatSeconds(media?.outroEnd));
  const [chapters, setChapters] = useState<ChapterItem[]>(media?.chapters || []);

  const [versions, setVersions] = useState<MediaVersionItem[]>([]);
  const [newMasterFile, setNewMasterFile] = useState<File | null>(null);
  const [newMasterLabel, setNewMasterLabel] = useState('');

  const [subFile, setSubFile] = useState<File | null>(null);
  const [subLang, setSubLang] = useState('en');
  const [subTitle, setSubTitle] = useState('English');
  const [subOffsetMs, setSubOffsetMs] = useState('0');
  const [subIsDefault, setSubIsDefault] = useState(false);
  const [subIsForced, setSubIsForced] = useState(false);

  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([]);
  const [selectedAiProvider, setSelectedAiProvider] = useState('gemini');
  const [aiLang, setAiLang] = useState('en');
  const [translateTargetLang, setTranslateTargetLang] = useState('Spanish');
  const [translateTargetCode, setTranslateTargetCode] = useState('es');
  const [suggestions, setSuggestions] = useState<IntroSuggestionItem[]>([]);
  const [mintedEmbedUrl, setMintedEmbedUrl] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!media) return;
    setTitle(media.title);
    setDescription(media.description || '');
    setFolder(media.folder || '');
    setVisibility(media.visibility);
    setAllowedDomainsText((media.allowedDomains || []).join(', '));
    setRequireSignedPlayback(Boolean(media.requireSignedPlayback));
    setIntroStart(formatSeconds(media.introStart));
    setIntroEnd(formatSeconds(media.introEnd));
    setOutroStart(formatSeconds(media.outroStart));
    setOutroEnd(formatSeconds(media.outroEnd));
    setChapters(media.chapters || []);
    setMintedEmbedUrl(null);
    setError(null);
  }, [media]);

  const loadStudioAuxData = useCallback(async () => {
    if (!media) return;
    try {
      const [vers, provs, sugs] = await Promise.all([
        fetchMediaVersions(media.id).catch(() => []),
        fetchAiProviders().catch(() => []),
        fetchIntroSuggestions(media.id).catch(() => []),
      ]);
      setVersions(vers);
      setAiProviders(provs);
      setSuggestions(sugs);
    } catch {}
  }, [media]);

  useEffect(() => {
    if (isOpen && media) {
      loadStudioAuxData();
    }
  }, [isOpen, media, loadStudioAuxData]);

  if (!isOpen || !media) return null;

  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const iStart = parseTimestamp(introStart);
    const iEnd = parseTimestamp(introEnd);
    const oStart = parseTimestamp(outroStart);
    const oEnd = parseTimestamp(outroEnd);

    if (iEnd > 0 && iEnd <= iStart) {
      setError('Intro End time must be greater than Intro Start time.');
      setIsSaving(false);
      return;
    }
    if (oEnd > 0 && oEnd <= oStart) {
      setError('Outro End time must be greater than Outro Start time.');
      setIsSaving(false);
      return;
    }

    const allowedDomains = allowedDomainsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const updated = await updateMediaItem(media.id, {
        title: title.trim(),
        description: description.trim(),
        folder: folder.trim(),
        visibility,
        allowedDomains,
        requireSignedPlayback,
        introStart: iStart,
        introEnd: iEnd,
        outroStart: oStart,
        outroEnd: oEnd,
        chapters,
      });
      toast.success('Media metadata & security policy saved.', 'Saved');
      onSaved(updated);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMintSignedLink = async () => {
    setIsActionRunning(true);
    try {
      const res = await mintSignedPlaybackGrant(media.id, 3600);
      const embedWithToken = `${window.location.origin}/embed/${media.id}?token=${encodeURIComponent(res.token)}`;
      setMintedEmbedUrl(embedWithToken);
      toast.success('Minted 1-hour HMAC-SHA256 signed embed link.', 'Signed URL Ready');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to mint signed URL', 'Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleUploadNewMaster = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMasterFile) return;
    setIsActionRunning(true);
    try {
      const formData = new FormData();
      formData.append('video', newMasterFile);
      formData.append('label', newMasterLabel.trim() || `Master ${new Date().toLocaleDateString()}`);
      await uploadNewMediaVersion(media.id, formData);
      setNewMasterFile(null);
      setNewMasterLabel('');
      toast.success('New master uploaded and queued for HLS packaging.', 'Version Queued');
      loadStudioAuxData();
    } catch (err: any) {
      toast.error(err?.message || 'Master upload failed', 'Version Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleRepackageHls = async () => {
    setIsActionRunning(true);
    try {
      const res = await queueHlsPackaging(media.id);
      toast.success(
        res.deduplicated ? 'Existing HLS job is already queued.' : 'HLS packaging job queued.',
        'HLS Queue'
      );
      loadStudioAuxData();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to queue HLS packaging', 'Queue Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleActivateVersion = async (versionId: string) => {
    setIsActionRunning(true);
    try {
      const updated = await activateMediaVersion(media.id, versionId);
      onSaved(updated);
      toast.success('Active playback master switched!', 'Version Activated');
      loadStudioAuxData();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to activate version', 'Activation Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleUploadSubtitle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subFile) return;
    setIsActionRunning(true);
    try {
      const fd = new FormData();
      fd.append('subtitle', subFile);
      fd.append('language', subLang.trim() || 'en');
      fd.append('title', subTitle.trim() || 'Subtitles');
      fd.append('offsetMs', String(Number(subOffsetMs) || 0));
      fd.append('isDefault', String(subIsDefault));
      fd.append('isForced', String(subIsForced));
      const updated = await uploadSubtitleFile(media.id, fd);
      onSaved(updated);
      setSubFile(null);
      toast.success('Subtitle track converted to WebVTT and attached.', 'Subtitle Uploaded');
    } catch (err: any) {
      toast.error(err?.message || 'Subtitle upload failed', 'Subtitle Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleToggleSubFlag = async (
    trackIndex: number,
    patch: { isDefault?: boolean; isForced?: boolean; offsetMs?: number }
  ) => {
    setIsActionRunning(true);
    try {
      const updated = await updateSubtitleTrack(media.id, trackIndex, patch);
      onSaved(updated);
      toast.success('Subtitle track updated.', 'Subtitles');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update track', 'Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleQueueTranscribe = async () => {
    setIsActionRunning(true);
    try {
      await queueAiTranscribe(media.id, { provider: selectedAiProvider, language: aiLang });
      toast.success(`Transcription job queued (${selectedAiProvider}). Monitor progress in Queue tab.`, 'AI Queued');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to queue transcription', 'AI Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleQueueTranslate = async () => {
    setIsActionRunning(true);
    try {
      await queueAiTranslate(media.id, {
        targetLanguage: translateTargetLang,
        targetCode: translateTargetCode,
        sourceTrackIndex: 0,
      });
      toast.success(`Subtitle translation to ${translateTargetLang} queued.`, 'AI Translation');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to queue translation', 'AI Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleDetectChapters = async () => {
    setIsActionRunning(true);
    try {
      await queueAiDetectChapters(media.id);
      toast.success('Intro/Outro & chapter detection queued. Refresh suggestions shortly.', 'AI Detection Queued');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to queue chapter detection', 'AI Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleApproveSuggestion = async (suggestionId: string) => {
    setIsActionRunning(true);
    try {
      const updated = await approveIntroSuggestion(media.id, suggestionId);
      onSaved(updated);
      setIntroStart(formatSeconds(updated.introStart));
      setIntroEnd(formatSeconds(updated.introEnd));
      setOutroStart(formatSeconds(updated.outroStart));
      setOutroEnd(formatSeconds(updated.outroEnd));
      setChapters(updated.chapters || []);
      toast.success('Intro/Outro & chapters applied to media.', 'Approved');
      loadStudioAuxData();
    } catch (err: any) {
      toast.error(err?.message || 'Approval failed', 'Error');
    } finally {
      setIsActionRunning(false);
    }
  };

  const handleRejectSuggestion = async (suggestionId: string) => {
    setIsActionRunning(true);
    try {
      await rejectIntroSuggestion(media.id, suggestionId);
      loadStudioAuxData();
    } finally {
      setIsActionRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div
        className="relative w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-2xl p-6 shadow-2xl my-8 text-zinc-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80 mb-4">
          <div>
            <h3 className="text-base font-bold text-white">Media Studio — {media.title}</h3>
            <p className="text-[11px] text-zinc-500 font-mono mt-0.5">
              ID: {media.id} • Mode: {media.playbackMode || 'legacy_telegram'}
              {media.sha256Hash ? ` • sha256:${media.sha256Hash.slice(0, 12)}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            aria-label="Close studio"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Studio Sub-tabs */}
        <div className="flex flex-wrap items-center gap-1.5 pb-4 border-b border-zinc-800/60 mb-5 text-xs">
          {[
            { id: 'metadata' as StudioTab, label: 'Metadata, Skip & Chapters' },
            { id: 'versions' as StudioTab, label: `Versions & HLS (${versions.length})` },
            { id: 'subtitles' as StudioTab, label: `Audio & Subtitles (${media.subtitleTracks?.length || 0})` },
            { id: 'ai' as StudioTab, label: 'AI Studio' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer ${
                activeTab === t.id
                  ? 'bg-red-600 text-white shadow'
                  : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* TAB 1: METADATA, SECURITY & CHAPTERS */}
        {activeTab === 'metadata' && (
          <form onSubmit={handleSaveMetadata} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-zinc-400 font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-zinc-400 font-medium mb-1">Folder</label>
                <input
                  type="text"
                  placeholder="e.g. Anime / Movies"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-zinc-400 font-medium mb-1">Visibility</label>
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as any)}
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 cursor-pointer"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private (Signed Required)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-zinc-400 font-medium mb-1">Description</label>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white resize-none"
              />
            </div>

            {/* Domain Allowlist & Signed Playback */}
            <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-zinc-200 font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={requireSignedPlayback}
                    onChange={(e) => setRequireSignedPlayback(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-red-600"
                  />
                  <span>Require HMAC-SHA256 Signed Playback URL</span>
                </label>

                <button
                  type="button"
                  onClick={handleMintSignedLink}
                  disabled={isActionRunning}
                  className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded-lg font-medium cursor-pointer"
                >
                  Mint 1h Signed Embed URL
                </button>
              </div>

              {mintedEmbedUrl && (
                <div className="p-2 bg-black/50 border border-zinc-800 rounded-lg font-mono text-[10px] text-emerald-300 break-all select-all">
                  {mintedEmbedUrl}
                </div>
              )}

              <div>
                <label className="block text-[11px] text-zinc-400 mb-1">Allowed Embed Domains (comma-separated)</label>
                <input
                  type="text"
                  placeholder="example.com, app.mysite.io"
                  value={allowedDomainsText}
                  onChange={(e) => setAllowedDomainsText(e.target.value)}
                  className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono"
                />
              </div>
            </div>

            {/* Intro / Outro Skip */}
            <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-2.5">
              <span className="font-semibold text-white block">Intro & Outro Skip Intervals</span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-[10px] text-zinc-400 mb-1">Intro Start</label>
                  <input
                    type="text"
                    placeholder="00:00"
                    value={introStart}
                    onChange={(e) => setIntroStart(e.target.value)}
                    className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400 mb-1">Intro End</label>
                  <input
                    type="text"
                    placeholder="01:30"
                    value={introEnd}
                    onChange={(e) => setIntroEnd(e.target.value)}
                    className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400 mb-1">Outro Start</label>
                  <input
                    type="text"
                    placeholder="22:10"
                    value={outroStart}
                    onChange={(e) => setOutroStart(e.target.value)}
                    className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400 mb-1">Outro End</label>
                  <input
                    type="text"
                    placeholder="23:45"
                    value={outroEnd}
                    onChange={(e) => setOutroEnd(e.target.value)}
                    className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center"
                  />
                </div>
              </div>
            </div>

            {/* Chapters editor */}
            <div className="p-3.5 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Seekbar Chapters ({chapters.length})</span>
                <button
                  type="button"
                  onClick={() =>
                    setChapters((prev) => [
                      ...prev,
                      { id: `ch_${Date.now()}`, title: `Chapter ${prev.length + 1}`, startTime: 0 },
                    ])
                  }
                  className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[11px] cursor-pointer"
                >
                  + Add Chapter
                </button>
              </div>
              {chapters.map((ch, idx) => (
                <div key={ch.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ch.title}
                    onChange={(e) =>
                      setChapters((prev) => prev.map((c, i) => (i === idx ? { ...c, title: e.target.value } : c)))
                    }
                    className="flex-1 px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white"
                  />
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={ch.startTime}
                    onChange={(e) =>
                      setChapters((prev) =>
                        prev.map((c, i) => (i === idx ? { ...c, startTime: Number(e.target.value) || 0 } : c))
                      )
                    }
                    className="w-24 px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center"
                    placeholder="sec"
                  />
                  <button
                    type="button"
                    onClick={() => setChapters((prev) => prev.filter((_, i) => i !== idx))}
                    className="px-2 py-1 text-red-400 hover:text-red-300 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {error && (
              <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300">{error}</div>
            )}

            <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}

        {/* TAB 2: IMMUTABLE VERSIONS & HLS ABR PACKAGING */}
        {activeTab === 'versions' && (
          <div className="space-y-4 text-xs">
            <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="font-bold text-white">HLS Adaptive Bitrate (ABR) Packaging</h4>
                <p className="text-[11px] text-zinc-400">
                  Packages non-upscaled ladder renditions, demuxed audio streams, and thumbnails into active storage.
                </p>
              </div>
              <button
                type="button"
                onClick={handleRepackageHls}
                disabled={isActionRunning}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer disabled:opacity-50 shrink-0"
              >
                Re-package Active HLS
              </button>
            </div>

            <form onSubmit={handleUploadNewMaster} className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-3">
              <h4 className="font-bold text-white">Upload New Immutable Master Version</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="file"
                  accept="video/*,.mkv,.mp4,.webm,.mov,.avi"
                  onChange={(e) => setNewMasterFile(e.target.files?.[0] || null)}
                  className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-300"
                  required
                />
                <input
                  type="text"
                  placeholder="Version label (e.g. v2 Remaster Dual Audio)"
                  value={newMasterLabel}
                  onChange={(e) => setNewMasterLabel(e.target.value)}
                  className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!newMasterFile || isActionRunning}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 rounded-xl font-semibold cursor-pointer disabled:opacity-50"
                >
                  Upload Master Version
                </button>
              </div>
            </form>

            <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
              {versions.map((ver) => {
                const isActive = media.activeVersionId === ver.id;
                return (
                  <div
                    key={ver.id}
                    className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                      isActive ? 'bg-red-950/20 border-red-500/40' : 'bg-zinc-900/50 border-zinc-800'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">v{ver.versionNumber}: {ver.label}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300">
                          {ver.status}
                        </span>
                        {isActive && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            ACTIVE
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-zinc-400">
                        Backend: {ver.storageBackend} • Renditions:{' '}
                        {ver.renditions?.length > 0 ? ver.renditions.map((r) => r.label).join(', ') : 'Pending/Legacy'}
                      </div>
                      {ver.error && <div className="text-[11px] text-red-400 font-mono">{ver.error}</div>}
                    </div>
                    {!isActive && ver.status === 'ready' && (
                      <button
                        type="button"
                        onClick={() => handleActivateVersion(ver.id)}
                        disabled={isActionRunning}
                        className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg font-semibold cursor-pointer"
                      >
                        Activate / Rollback
                      </button>
                    )}
                  </div>
                );
              })}
              {versions.length === 0 && (
                <p className="text-zinc-500 text-center py-4">No immutable versions recorded for this legacy asset yet.</p>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: SUBTITLES & AUDIO TRACKS STUDIO */}
        {activeTab === 'subtitles' && (
          <div className="space-y-4 text-xs">
            <form onSubmit={handleUploadSubtitle} className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-3">
              <h4 className="font-bold text-white">Upload External Subtitles (.srt, .ass, .vtt)</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <input
                  type="file"
                  accept=".vtt,.srt,.ass,.ssa"
                  onChange={(e) => setSubFile(e.target.files?.[0] || null)}
                  className="sm:col-span-3 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-300"
                  required
                />
                <input
                  type="text"
                  placeholder="Lang code (en, es, ja, bn)"
                  value={subLang}
                  onChange={(e) => setSubLang(e.target.value)}
                  className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono"
                />
                <input
                  type="text"
                  placeholder="Display Title (English [CC])"
                  value={subTitle}
                  onChange={(e) => setSubTitle(e.target.value)}
                  className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white"
                />
                <input
                  type="number"
                  placeholder="Offset (ms, e.g. -500)"
                  value={subOffsetMs}
                  onChange={(e) => setSubOffsetMs(e.target.value)}
                  className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-4">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subIsDefault}
                      onChange={(e) => setSubIsDefault(e.target.checked)}
                    />
                    <span>Default Track</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subIsForced}
                      onChange={(e) => setSubIsForced(e.target.checked)}
                    />
                    <span>Forced Track</span>
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={!subFile || isActionRunning}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer disabled:opacity-50"
                >
                  Convert & Attach WebVTT
                </button>
              </div>
            </form>

            <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
              <h4 className="font-bold text-white">Attached Subtitle Tracks ({media.subtitleTracks?.length || 0})</h4>
              {(media.subtitleTracks || []).map((track) => (
                <div
                  key={track.index}
                  className="p-3 bg-zinc-900/50 border border-zinc-800 rounded-xl flex flex-wrap items-center justify-between gap-2"
                >
                  <div>
                    <div className="font-semibold text-white">
                      {track.title || `Track ${track.index + 1}`}{' '}
                      <span className="text-[10px] font-mono text-zinc-400">({track.language || 'und'})</span>
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500">
                      Source: {track.source || 'embedded'} • Offset: {track.offsetMs || 0}ms
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggleSubFlag(track.index, { isDefault: !track.isDefault })}
                      className={`px-2 py-1 rounded-lg border text-[10px] font-mono cursor-pointer ${
                        track.isDefault
                          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-400'
                      }`}
                    >
                      {track.isDefault ? 'Default ✓' : 'Set Default'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleSubFlag(track.index, { isForced: !track.isForced })}
                      className={`px-2 py-1 rounded-lg border text-[10px] font-mono cursor-pointer ${
                        track.isForced
                          ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                          : 'bg-zinc-950 border-zinc-800 text-zinc-400'
                      }`}
                    >
                      {track.isForced ? 'Forced ✓' : 'Forced'}
                    </button>
                  </div>
                </div>
              ))}
              {(!media.subtitleTracks || media.subtitleTracks.length === 0) && (
                <p className="text-zinc-500">No subtitle tracks attached yet. Upload one above or generate via AI Studio.</p>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: AI STUDIO */}
        {activeTab === 'ai' && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Speech to WebVTT */}
              <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-2.5">
                <h4 className="font-bold text-white">AI Speech-to-WebVTT Captions</h4>
                <select
                  value={selectedAiProvider}
                  onChange={(e) => setSelectedAiProvider(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200"
                >
                  {aiProviders.length > 0 ? (
                    aiProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName} {p.configured ? '(Ready)' : '(Key Required)'}
                      </option>
                    ))
                  ) : (
                    <option value="gemini">Gemini Audio Transcribe</option>
                  )}
                </select>
                <input
                  type="text"
                  placeholder="Language hint (en, ja, bn)"
                  value={aiLang}
                  onChange={(e) => setAiLang(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono"
                />
                <button
                  type="button"
                  onClick={handleQueueTranscribe}
                  disabled={isActionRunning}
                  className="w-full py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer disabled:opacity-50"
                >
                  Queue Transcription
                </button>
              </div>

              {/* Translate Subtitles */}
              <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-2.5">
                <h4 className="font-bold text-white">AI Subtitle Translation</h4>
                <input
                  type="text"
                  placeholder="Target Language (e.g. Bengali, Japanese)"
                  value={translateTargetLang}
                  onChange={(e) => setTranslateTargetLang(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white"
                />
                <input
                  type="text"
                  placeholder="ISO Code (e.g. bn, ja, es)"
                  value={translateTargetCode}
                  onChange={(e) => setTranslateTargetCode(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-white font-mono"
                />
                <button
                  type="button"
                  onClick={handleQueueTranslate}
                  disabled={isActionRunning}
                  className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white rounded-xl font-semibold cursor-pointer disabled:opacity-50"
                >
                  Translate Primary Subtitle
                </button>
              </div>
            </div>

            {/* Intro / Outro & Chapter Detection */}
            <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h4 className="font-bold text-white">FFmpeg Black/Silence + Gemini Intro/Chapter Detection</h4>
                  <p className="text-[11px] text-zinc-400">
                    Detects scene cuts & silence boundaries, proposes timestamps for operator approval before overwriting.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDetectChapters}
                  disabled={isActionRunning}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold cursor-pointer shrink-0 disabled:opacity-50"
                >
                  Run AI Detection
                </button>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                {suggestions.map((sug) => (
                  <div
                    key={sug.id}
                    className="p-3 bg-zinc-950/80 border border-zinc-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">
                          Intro {sug.introStart}s–{sug.introEnd}s • Outro {sug.outroStart}s–{sug.outroEnd}s
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300">
                          {sug.status}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400">
                        {sug.confidenceNote} ({sug.chapters?.length || 0} chapters proposed)
                      </p>
                    </div>
                    {sug.status === 'pending' && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleApproveSuggestion(sug.id)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold cursor-pointer"
                        >
                          Approve & Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectSuggestion(sug.id)}
                          className="px-2.5 py-1.5 bg-zinc-800 text-zinc-300 rounded-lg cursor-pointer"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {suggestions.length === 0 && (
                  <p className="text-zinc-500">No AI chapter/intro suggestions generated yet.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
