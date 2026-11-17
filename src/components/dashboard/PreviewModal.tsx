import React, { useEffect, useState } from 'react';
import { MediaItem, PlaybackDescriptor } from '../../types/media';
import { fetchPlaybackDescriptor } from '../../services/api';
import { VideoPlayer } from '../player/VideoPlayer';

interface PreviewModalProps {
  media: MediaItem | null;
  isOpen: boolean;
  onClose: () => void;
  isDemo?: boolean;
}

export const PreviewModal: React.FC<PreviewModalProps> = ({
  media,
  isOpen,
  onClose,
  isDemo = false,
}) => {
  const [descriptor, setDescriptor] = useState<PlaybackDescriptor | null>(null);

  useEffect(() => {
    if (!isOpen || isDemo || !media) {
      setDescriptor(null);
      return;
    }
    let mounted = true;
    fetchPlaybackDescriptor(media.id)
      .then((desc) => {
        if (mounted) setDescriptor(desc);
      })
      .catch(() => {
        if (mounted) setDescriptor(null);
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, isDemo, media]);

  if (!isOpen) return null;

  const demoVideoUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  const src = isDemo || !media ? demoVideoUrl : descriptor?.legacyStreamUrl || `/api/media/${media.id}/stream`;
  const title = isDemo || !media ? 'Demo Video — Skip Intro & Outro Testing' : media.title;
  const introStart = isDemo || !media ? 5 : media.introStart;
  const introEnd = isDemo || !media ? 15 : media.introEnd;
  const outroStart = isDemo || !media ? 580 : media.outroStart;
  const outroEnd = isDemo || !media ? 596 : media.outroEnd;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-md overflow-y-auto">
      <div
        className="relative w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 sm:p-4 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse" />
            <h3 className="text-xs sm:text-sm font-semibold text-white truncate max-w-md">{title}</h3>
            {descriptor?.playbackMode === 'hls_v2' && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-500/30">
                HLS ABR
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            aria-label="Close preview"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="w-full bg-black">
          <VideoPlayer
            src={src}
            hlsSrc={isDemo ? undefined : descriptor?.hlsManifestUrl}
            poster={isDemo ? undefined : descriptor?.posterUrl}
            mediaId={media?.id}
            title={title}
            introStart={introStart}
            introEnd={introEnd}
            outroStart={outroStart}
            outroEnd={outroEnd}
            audioTracks={descriptor?.audioTracks}
            subtitleTracks={descriptor?.subtitleTracks}
            chapters={descriptor?.chapters || media?.chapters}
            autoPlay={true}
          />
        </div>

        <div className="p-3.5 bg-zinc-950 text-xs text-zinc-400 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-900">
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <span>Intro skip: {introStart || 0}s–{introEnd || 0}s</span>
            <span>•</span>
            <span>Outro skip: {outroStart || 0}s–{outroEnd || 0}s</span>
          </div>
          <span className="text-[11px] text-zinc-500">
            Click to Play/Pause • Double-tap left/right to seek 10s
          </span>
        </div>
      </div>
    </div>
  );
};
