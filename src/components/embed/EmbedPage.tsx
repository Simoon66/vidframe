import React, { useState, useEffect } from 'react';
import { PlaybackDescriptor, SeriesRecord } from '../../types/media';
import { fetchPlaybackDescriptor } from '../../services/api';
import { VideoPlayer } from '../player/VideoPlayer';

interface EmbedPageProps {
  mediaId?: string;
  source?: string;
  sourceId?: string;
}

export const EmbedPage: React.FC<EmbedPageProps> = ({ mediaId, source, sourceId }) => {
  const [descriptor, setDescriptor] = useState<PlaybackDescriptor | null>(null);
  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [currentSeasonNum, setCurrentSeasonNum] = useState<number>(1);
  const [currentEpNum, setCurrentEpNum] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sParam = params.get('s');
    const eParam = params.get('e');
    const tokenParam = params.get('token') || undefined;

    if (sParam) setCurrentSeasonNum(parseInt(sParam, 10));
    if (eParam) setCurrentEpNum(parseInt(eParam, 10));

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    async function loadData() {
      try {
        if (mediaId) {
          const desc = await fetchPlaybackDescriptor(mediaId, tokenParam);
          if (isMounted) {
            setDescriptor(desc);
            setIsLoading(false);
          }
        } else if (source && sourceId) {
          const seriesKey = `${source}_${sourceId}`;
          const res = await fetch(`/api/series/${seriesKey}`);
          const seriesData = await res.json();
          if (!res.ok) throw new Error(seriesData.error || 'Series project not found');

          if (isMounted) {
            setSeries(seriesData);
            const season =
              seriesData.seasons.find((s: any) => s.seasonNumber === (sParam ? parseInt(sParam, 10) : 1)) ||
              seriesData.seasons[0];
            if (season) {
              const ep =
                season.episodes.find((e: any) => e.episodeNumber === (eParam ? parseInt(eParam, 10) : 1)) ||
                season.episodes[0];
              if (ep && ep.mediaId) {
                const desc = await fetchPlaybackDescriptor(ep.mediaId, tokenParam);
                setDescriptor(desc);
              }
            }
            setIsLoading(false);
          }
        } else {
          throw new Error('Invalid embed route parameters.');
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || 'Failed to load video or series embed');
          setIsLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, [mediaId, source, sourceId]);

  const activeSeason = series?.seasons.find((s) => s.seasonNumber === currentSeasonNum) || series?.seasons[0];
  const activeEpisode = activeSeason?.episodes.find((e) => e.episodeNumber === currentEpNum) || activeSeason?.episodes[0];
  const media = descriptor?.media || null;

  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-[#0a0a0c] flex items-center justify-center">
        <div className="w-10 h-10 rounded-full border-3 border-zinc-800 border-t-red-600 animate-spin" />
      </div>
    );
  }

  if (error || (!media && !series)) {
    return (
      <div className="w-screen h-screen bg-[#0a0a0c] flex flex-col items-center justify-center text-center p-4">
        <p className="text-white font-medium text-sm mb-1">Video Unavailable</p>
        <p className="text-zinc-500 text-xs">{error || 'Could not load video embed'}</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center overflow-hidden">
      <VideoPlayer
        src={descriptor?.legacyStreamUrl || ''}
        hlsSrc={descriptor?.hlsManifestUrl}
        mediaId={media?.id}
        title={media?.title}
        poster={descriptor?.posterUrl || activeEpisode?.thumbnail || series?.coverImage}
        seriesTitle={series?.title}
        seasonNumber={activeSeason?.seasonNumber}
        episodeNumber={activeEpisode?.episodeNumber}
        episodeTitle={activeEpisode?.title}
        description={activeEpisode?.description || series?.description}
        introStart={media?.introStart}
        introEnd={media?.introEnd}
        outroStart={media?.outroStart}
        outroEnd={media?.outroEnd}
        audioTracks={descriptor?.audioTracks}
        subtitleTracks={descriptor?.subtitleTracks}
        chapters={descriptor?.chapters}
        renditions={descriptor?.renditions}
        autoPlay={false}
        className="w-full h-full rounded-none"
      />
    </div>
  );
};
