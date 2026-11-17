import React, { useState, useEffect } from 'react';
import { PlaybackDescriptor } from '../../types/media';
import { fetchPlaybackDescriptor } from '../../services/api';
import { VideoPlayer } from '../player/VideoPlayer';

interface WatchPageProps {
  mediaId: string;
  onNavigateHome: () => void;
}

export const WatchPage: React.FC<WatchPageProps> = ({ mediaId, onNavigateHome }) => {
  const [descriptor, setDescriptor] = useState<PlaybackDescriptor | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const token = new URLSearchParams(window.location.search).get('token') || undefined;

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    setError(null);

    fetchPlaybackDescriptor(mediaId, token)
      .then((desc) => {
        if (isMounted) {
          setDescriptor(desc);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message || 'Media not found');
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [mediaId, token]);

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const media = descriptor?.media || null;
  const appOrigin = window.location.origin;
  const tokenQuery = descriptor?.signedToken ? `?token=${encodeURIComponent(descriptor.signedToken)}` : token ? `?token=${encodeURIComponent(token)}` : '';
  const embedUrl = `${appOrigin}/embed/${mediaId}${media?.visibility === 'private' ? tokenQuery : ''}`;
  const iframeSnippet = `<iframe src="${embedUrl}" title="${media?.title || 'VidFrame Video'}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" frameborder="0"></iframe>`;

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md px-4 sm:px-6 h-14 flex items-center justify-between">
        <button
          onClick={onNavigateHome}
          className="flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-white transition cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          <span>Back to VidFrame Dashboard</span>
        </button>

        <div className="flex items-center gap-2">
          {descriptor?.playbackMode === 'hls_v2' && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-600/15 border border-red-500/30 text-red-300">
              HLS ABR
            </span>
          )}
          <a
            href={embedUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium rounded-lg transition"
          >
            Standalone Embed ↗
          </a>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        {isLoading ? (
          <div className="aspect-video w-full bg-zinc-950 rounded-2xl border border-zinc-800 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full border-3 border-zinc-800 border-t-red-600 animate-spin" />
          </div>
        ) : error || !media || !descriptor ? (
          <div className="aspect-video w-full bg-zinc-950 rounded-2xl border border-zinc-800 flex flex-col items-center justify-center p-6 text-center">
            <p className="text-red-400 font-semibold mb-2">Video Unavailable</p>
            <p className="text-zinc-500 text-xs mb-4">{error || 'Could not locate media item with ID ' + mediaId}</p>
            <button
              onClick={onNavigateHome}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-medium transition cursor-pointer"
            >
              Return to Library
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-2xl border border-zinc-800/80 shadow-2xl bg-black">
              <VideoPlayer
                src={descriptor.legacyStreamUrl}
                hlsSrc={descriptor.hlsManifestUrl}
                poster={descriptor.posterUrl}
                mediaId={media.id}
                title={media.title}
                introStart={media.introStart}
                introEnd={media.introEnd}
                outroStart={media.outroStart}
                outroEnd={media.outroEnd}
                audioTracks={descriptor.audioTracks}
                subtitleTracks={descriptor.subtitleTracks}
                chapters={descriptor.chapters}
                renditions={descriptor.renditions}
                autoPlay={false}
              />
            </div>

            <div className="p-6 bg-zinc-900/60 border border-zinc-800 rounded-2xl space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h1 className="text-lg sm:text-xl font-bold text-white mb-1">{media.title}</h1>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 font-mono">
                    <span>ID: {media.id}</span>
                    <span>•</span>
                    <span>{(media.size / (1024 * 1024)).toFixed(1)} MB</span>
                    <span>•</span>
                    <span className="capitalize">{media.visibility}</span>
                    <span>•</span>
                    <span>{media.views ?? 0} views</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => copyToClipboard(embedUrl, 'embed')}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition cursor-pointer border border-zinc-700"
                  >
                    {copiedType === 'embed' ? '✓ Copied Embed' : 'Copy Embed URL'}
                  </button>
                  <button
                    onClick={() => copyToClipboard(iframeSnippet, 'iframe')}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition cursor-pointer border border-zinc-700"
                  >
                    {copiedType === 'iframe' ? '✓ Copied Code' : 'Copy <iframe>'}
                  </button>
                </div>
              </div>

              {media.description && (
                <div className="p-4 bg-zinc-950/80 rounded-xl border border-zinc-800/80 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {media.description}
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-zinc-400">Embed Snippet</span>
                <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800 text-[11px] font-mono text-zinc-400 break-all select-all">
                  {iframeSnippet}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};
