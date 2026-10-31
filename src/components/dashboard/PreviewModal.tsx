import React from 'react';
import { MediaItem } from '../../types/media';
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
  if (!isOpen) return null;

  // If demo preview, provide a public high quality sample clip with sample intro/outro times
  const demoVideoUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  const src = isDemo || !media ? demoVideoUrl : `/api/media/${media.id}/stream`;
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
        {/* Header */}
        <div className="p-3 sm:p-4 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse" />
            <h3 className="text-xs sm:text-sm font-semibold text-white truncate max-w-md">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition cursor-pointer"
            aria-label="Close preview"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Video Player */}
        <div className="w-full bg-black">
          <VideoPlayer
            src={src}
            mediaId={media?.id}
            title={title}
            introStart={introStart}
            introEnd={introEnd}
            outroStart={outroStart}
            outroEnd={outroEnd}
            autoPlay={true}
          />
        </div>

        {/* Footer info */}
        <div className="p-3.5 bg-zinc-950 text-xs text-zinc-400 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-900">
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <span>Intro skip test: {introStart}s–{introEnd}s</span>
            <span>•</span>
            <span>Outro skip test: {outroStart}s–{outroEnd}s</span>
          </div>
          <span className="text-[11px] text-zinc-500">
            Press Space to Play/Pause, ←/→ for 10s seeking, F for Fullscreen
          </span>
        </div>
      </div>
    </div>
  );
};
