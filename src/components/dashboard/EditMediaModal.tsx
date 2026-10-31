import React, { useState } from 'react';
import { MediaItem } from '../../types/media';
import { updateMediaItem } from '../../services/api';

interface EditMediaModalProps {
  media: MediaItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (updated: MediaItem) => void;
}

export const EditMediaModal: React.FC<EditMediaModalProps> = ({
  media,
  isOpen,
  onClose,
  onSaved,
}) => {
  if (!isOpen || !media) return null;

  // Format seconds into MM:SS or HH:MM:SS
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
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts[0] || 0;
  };

  const [title, setTitle] = useState(media.title);
  const [description, setDescription] = useState(media.description || '');
  const [visibility, setVisibility] = useState(media.visibility);

  const [introStart, setIntroStart] = useState(formatSeconds(media.introStart));
  const [introEnd, setIntroEnd] = useState(formatSeconds(media.introEnd));
  const [outroStart, setOutroStart] = useState(formatSeconds(media.outroStart));
  const [outroEnd, setOutroEnd] = useState(formatSeconds(media.outroEnd));

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
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

    if (media.duration) {
      if (iEnd > media.duration) {
        setError(`Intro End (${iEnd}s) exceeds video duration (${Math.round(media.duration)}s).`);
        setIsSaving(false);
        return;
      }
      if (oEnd > media.duration) {
        setError(`Outro End (${oEnd}s) exceeds video duration (${Math.round(media.duration)}s).`);
        setIsSaving(false);
        return;
      }
    }

    try {
      const updated = await updateMediaItem(media.id, {
        title: title.trim(),
        description: description.trim(),
        visibility,
        introStart: iStart,
        introEnd: iEnd,
        outroStart: oStart,
        outroEnd: oEnd,
      });

      setIsSaving(false);
      onSaved(updated);
      onClose();
    } catch (err: any) {
      setIsSaving(false);
      setError(err?.message || 'Failed to save changes');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div
        className="relative w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl p-6 shadow-2xl my-8 text-zinc-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80 mb-5">
          <div>
            <h3 className="text-base font-bold text-white">Edit Video Metadata & Skip Intervals</h3>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">Media ID: {media.id}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            aria-label="Close edit modal"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4 text-xs">
          {/* Title & Visibility */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-zinc-400 font-medium mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
              />
            </div>

            <div>
              <label className="block text-zinc-400 font-medium mb-1">Visibility</label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as any)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-300 focus:outline-none focus:border-red-500/80 transition cursor-pointer"
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-zinc-400 font-medium mb-1">Description</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition resize-none"
            />
          </div>

          {/* Intro / Outro Skip Fields */}
          <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-semibold text-white">Intro & Outro Skip Intervals</span>
                <p className="text-[11px] text-zinc-400">
                  Player will automatically display "Skip Intro" or "Skip Outro" buttons during these ranges.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-[10px] text-zinc-400 font-medium mb-1">Intro Start</label>
                <input
                  type="text"
                  placeholder="00:00"
                  value={introStart}
                  onChange={(e) => setIntroStart(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center focus:outline-none focus:border-red-500/80"
                />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-400 font-medium mb-1">Intro End</label>
                <input
                  type="text"
                  placeholder="01:30"
                  value={introEnd}
                  onChange={(e) => setIntroEnd(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center focus:outline-none focus:border-red-500/80"
                />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-400 font-medium mb-1">Outro Start</label>
                <input
                  type="text"
                  placeholder="22:10"
                  value={outroStart}
                  onChange={(e) => setOutroStart(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center focus:outline-none focus:border-red-500/80"
                />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-400 font-medium mb-1">Outro End</label>
                <input
                  type="text"
                  placeholder="23:45"
                  value={outroEnd}
                  onChange={(e) => setOutroEnd(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-white font-mono text-center focus:outline-none focus:border-red-500/80"
                />
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 italic">
              Format: MM:SS or HH:MM:SS or pure seconds. Leave blank to disable.
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-xl text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl transition cursor-pointer font-medium disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-semibold shadow-lg shadow-red-950/50 transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
