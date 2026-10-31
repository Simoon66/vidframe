import React, { useState, useEffect } from 'react';
import { MediaItem, SeriesRecord } from '../../types/media';
import { fetchMediaItem } from '../../services/api';
import { VideoPlayer } from '../player/VideoPlayer';

interface EmbedPageProps {
  mediaId?: string;
  source?: string;
  sourceId?: string;
}

export const EmbedPage: React.FC<EmbedPageProps> = ({ mediaId, source, sourceId }) => {
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [currentSeasonNum, setCurrentSeasonNum] = useState<number>(1);
  const [currentEpNum, setCurrentEpNum] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sParam = params.get('s');
    const eParam = params.get('e');
    if (sParam) setCurrentSeasonNum(parseInt(sParam, 10));
    if (eParam) setCurrentEpNum(parseInt(eParam, 10));

    let isMounted = true;
    setIsLoading(true);

    async function loadData() {
      try {
        if (mediaId) {
          const item = await fetchMediaItem(mediaId);
          if (isMounted) {
            setMedia(item);
            setIsLoading(false);
          }
        } else if (source && sourceId) {
          const seriesKey = `${source}_${sourceId}`;
          const res = await fetch(`/api/series/${seriesKey}`);
          const seriesData = await res.json();
          if (!res.ok) throw new Error(seriesData.error || 'Series project not found');

          if (isMounted) {
            setSeries(seriesData);
            const season = seriesData.seasons.find((s: any) => s.seasonNumber === (sParam ? parseInt(sParam, 10) : 1)) || seriesData.seasons[0];
            if (season) {
              const ep = season.episodes.find((e: any) => e.episodeNumber === (eParam ? parseInt(eParam, 10) : 1)) || season.episodes[0];
              if (ep && ep.mediaId) {
                const mediaItem = await fetchMediaItem(ep.mediaId);
                setMedia(mediaItem);
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

  const streamUrl = media ? `/api/media/${media.id}/stream` : '';

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
        src={streamUrl}
        mediaId={media?.id}
        title={media?.title}
        poster={activeEpisode?.thumbnail || series?.coverImage}
        seriesTitle={series?.title}
        seasonNumber={activeSeason?.seasonNumber}
        episodeNumber={activeEpisode?.episodeNumber}
        episodeTitle={activeEpisode?.title}
        description={activeEpisode?.description || series?.description}
        introStart={media?.introStart}
        introEnd={media?.introEnd}
        outroStart={media?.outroStart}
        outroEnd={media?.outroEnd}
        autoPlay={false}
        className="w-full h-full rounded-none"
      />
    </div>
  );
};
