import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import {
  PlayIcon,
  PauseIcon,
  RewindIcon,
  FastForwardIcon,
  VolumeLowIcon,
  VolumeMediumIcon,
  VolumeHighIcon,
  MuteIcon,
  AudioTrackIcon,
  SubtitlesIcon,
  SettingsIcon,
  ResolutionHDIcon,
  PlaybackSpeedGaugeIcon,
  EnterFullscreenIcon,
  ExitFullscreenIcon,
  SkipIntroOutroIcon,
  ChevronLeftIcon,
} from './Icons';
import { ReportModal, ReportFlagIcon } from './ReportModal';
import { recordMediaView } from '../../services/api';

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  title?: string;
  mediaId?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  description?: string;
  introStart?: number;
  introEnd?: number;
  outroStart?: number;
  outroEnd?: number;
  autoPlay?: boolean;
  subtitlesUrl?: string;
  subtitlesLabel?: string;
  className?: string;
  onError?: (err: any) => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  poster,
  title,
  mediaId,
  seriesTitle,
  seasonNumber,
  episodeNumber,
  episodeTitle,
  description,
  introStart = 0,
  introEnd = 0,
  outroStart = 0,
  outroEnd = 0,
  autoPlay = false,
  subtitlesUrl,
  subtitlesLabel = 'English [CC]',
  className = '',
  onError,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const hideControlsTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [bufferedPercent, setBufferedPercent] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPiPSupported, setIsPiPSupported] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [hasEnded, setHasEnded] = useState<boolean>(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [videoHeight, setVideoHeight] = useState<number>(1080);

  // Extracted Audio and Subtitle Tracks
  const [availableAudioTracks, setAvailableAudioTracks] = useState<Array<{
    index: number;
    language?: string;
    title?: string;
    codec?: string;
    channels?: number;
  }>>([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(0);
  const [availableSubtitleTracks, setAvailableSubtitleTracks] = useState<Array<{
    index: number;
    language?: string;
    title?: string;
    format?: string;
    url?: string;
  }>>([]);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState<number | null>(null);
  const [isLoadingTracks, setIsLoadingTracks] = useState<boolean>(false);
  const [showUnmutePrompt, setShowUnmutePrompt] = useState<boolean>(false);

  // UI state
  const [showControls, setShowControls] = useState<boolean>(true);
  const [activeMenu, setActiveMenu] = useState<'none' | 'main' | 'speed' | 'quality' | 'audio' | 'subtitles'>('none');
  const [selectedQuality, setSelectedQuality] = useState<string>('Auto (Adaptive)');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(false);
  const [isDraggingSeek, setIsDraggingSeek] = useState<boolean>(false);
  const [showReportModal, setShowReportModal] = useState<boolean>(false);
  const hasRecordedViewRef = useRef<boolean>(false);
  const streamRetryCountRef = useRef<number>(0);

  // Fetch real embedded audio & subtitle tracks (MKV / MP4)
  useEffect(() => {
    const effectiveId = mediaId || src.split('/media/')[1]?.split('/stream')[0] || '';
    if (!effectiveId) return;

    let isCancelled = false;
    setIsLoadingTracks(true);

    fetch(`/api/media/${effectiveId}/tracks`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;

        if (Array.isArray(data.audioTracks) && data.audioTracks.length > 0) {
          setAvailableAudioTracks(data.audioTracks);
        }
        if (Array.isArray(data.subtitleTracks) && data.subtitleTracks.length > 0) {
          setAvailableSubtitleTracks(data.subtitleTracks);
        }
      })
      .catch((err) => {
        console.warn('Tracks fetch error:', err);
      })
      .finally(() => {
        if (!isCancelled) setIsLoadingTracks(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [mediaId, src]);

  // Real View Analytics Tracking (Fires once per playback session)
  useEffect(() => {
    if (isPlaying && !hasRecordedViewRef.current) {
      const effectiveId = mediaId || src.split('/media/')[1]?.split('/stream')[0] || '';
      if (effectiveId) {
        hasRecordedViewRef.current = true;
        recordMediaView(effectiveId, episodeTitle || title || seriesTitle).catch(() => {});
      }
    }
  }, [isPlaying, mediaId, src, episodeTitle, title, seriesTitle]);

  // Pause overlay after 7 seconds
  const [showPausedOverlay, setShowPausedOverlay] = useState<boolean>(false);
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Double tap feedback
  const [doubleTapFeedback, setDoubleTapFeedback] = useState<'left' | 'right' | null>(null);
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });

  const formatTime = (seconds: number): string => {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const playPromiseRef = useRef<Promise<void> | null>(null);
  const isMountedRef = useRef<boolean>(true);

  // Safe Play Engine: Prevents "play() request was interrupted because the media was removed from the document"
  const safePlay = useCallback(async (shouldMuteOnBlock = false) => {
    const video = videoRef.current;
    if (!video || !isMountedRef.current) return;

    try {
      const promise = video.play();
      if (promise !== undefined) {
        playPromiseRef.current = promise;
        await promise;
        playPromiseRef.current = null;
        if (isMountedRef.current) {
          setIsPlaying(true);
          setHasEnded(false);
          setShowPausedOverlay(false);
        }
      }
    } catch (err: any) {
      playPromiseRef.current = null;
      // AbortError is normal when media is removed from document (unmount) or paused before start
      if (err?.name === 'AbortError' || err?.message?.includes('interrupted')) {
        return;
      }
      // NotAllowedError is normal when browser blocks unmuted autoplay
      if (err?.name === 'NotAllowedError') {
        if (shouldMuteOnBlock && isMountedRef.current && videoRef.current) {
          try {
            videoRef.current.muted = true;
            setIsMuted(true);
            setShowUnmutePrompt(true);
            const mutedPromise = videoRef.current.play();
            if (mutedPromise !== undefined) {
              playPromiseRef.current = mutedPromise;
              await mutedPromise;
              playPromiseRef.current = null;
              if (isMountedRef.current) {
                setIsPlaying(true);
                setHasEnded(false);
                setShowPausedOverlay(false);
              }
            }
            return;
          } catch {
            playPromiseRef.current = null;
          }
        }
        if (isMountedRef.current) {
          setIsPlaying(false);
        }
        return;
      }
      // Do not log aborts as severe console errors
      console.warn('Playback notice:', err?.message || err);
    }
  }, []);

  // Safe Pause Engine: Waits for in-flight play promises to settle before pausing to avoid AbortErrors
  const safePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (playPromiseRef.current) {
      playPromiseRef.current
        .then(() => {
          if (videoRef.current && isMountedRef.current) {
            videoRef.current.pause();
            setIsPlaying(false);
          }
        })
        .catch(() => {
          if (videoRef.current && isMountedRef.current) {
            videoRef.current.pause();
            setIsPlaying(false);
          }
        });
    } else {
      video.pause();
      if (isMountedRef.current) {
        setIsPlaying(false);
      }
    }
  }, []);

  // Global component mount/unmount cleanup
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const video = videoRef.current;
      if (video) {
        try {
          if (playPromiseRef.current) {
            playPromiseRef.current
              .catch(() => {})
              .finally(() => {
                try {
                  video.pause();
                  video.removeAttribute('src');
                  video.load();
                } catch {}
              });
          } else {
            video.pause();
            video.removeAttribute('src');
            video.load();
          }
        } catch {}
      }
    };
  }, []);

  // Active stream source with audio track parameter for MKV / multi-track streams
  const activeSrc = useMemo(() => {
    if (!src) return '';
    try {
      const url = new URL(src, window.location.origin);
      if (selectedAudioTrack > 0) {
        url.searchParams.set('audio', String(selectedAudioTrack));
      } else {
        url.searchParams.delete('audio');
      }
      return url.pathname + url.search;
    } catch {
      return src;
    }
  }, [src, selectedAudioTrack]);

  // Setup HLS or standard HTML5 Video with multi-audio track hot-switching
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeSrc) return;

    setPlaybackError(null);
    setIsBuffering(false);

    let hls: Hls | null = null;
    const isHlsStream = activeSrc.includes('.m3u8');

    if (isHlsStream && Hls.isSupported()) {
      hls = new Hls({
        capLevelToPlayerSize: true,
        autoStartLoad: true,
      });
      hls.loadSource(activeSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsBuffering(false);
        if (autoPlay && isMountedRef.current) {
          safePlay(true);
        }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setPlaybackError('Failed to load video stream.');
          if (onError) onError(data);
        }
      });
    } else {
      const prevSrc = video.getAttribute('data-active-src');
      const isSwitchingAudio = Boolean(prevSrc && prevSrc !== activeSrc);
      const prevTime = video.currentTime;
      const wasPlaying = !video.paused;

      video.setAttribute('data-active-src', activeSrc);
      video.src = activeSrc;

      if (isSwitchingAudio) {
        const restoreTimeAndPlay = () => {
          if (videoRef.current && isMountedRef.current) {
            try {
              videoRef.current.currentTime = prevTime;
            } catch {}
            if (wasPlaying) {
              safePlay();
            }
          }
        };
        video.addEventListener('loadedmetadata', restoreTimeAndPlay, { once: true });
        video.load();
      } else {
        video.load();
        if (autoPlay && isMountedRef.current) {
          setIsBuffering(true);
          video.muted = true;
          setIsMuted(true);
          setShowUnmutePrompt(true);
          safePlay(true);
        }
      }
    }

    if (document.pictureInPictureEnabled) {
      setIsPiPSupported(true);
    }

    return () => {
      if (hls) {
        hls.destroy();
      }
      if (video) {
        try {
          if (playPromiseRef.current) {
            playPromiseRef.current
              .catch(() => {})
              .finally(() => {
                try {
                  video.pause();
                } catch {}
              });
          } else {
            video.pause();
          }
        } catch {}
      }
    };
  }, [activeSrc, autoPlay, onError, safePlay]);

  // Activity timer for fading controls
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) {
      clearTimeout(hideControlsTimerRef.current);
    }
    if (isPlaying && activeMenu === 'none') {
      hideControlsTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3500);
    }
  }, [isPlaying, activeMenu]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (hideControlsTimerRef.current) {
        clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [isPlaying, activeMenu, resetControlsTimeout]);

  // 7-second pause duration timer for immersive show overlay
  useEffect(() => {
    if (!isPlaying) {
      pauseTimerRef.current = setTimeout(() => {
        setShowPausedOverlay(true);
      }, 7000); // exactly 7 seconds
    } else {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
      setShowPausedOverlay(false);
    }
    return () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    };
  }, [isPlaying]);

  // Click outside popover menus
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (activeMenu !== 'none' && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActiveMenu('none');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activeMenu]);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused || video.ended) {
      safePlay();
    } else {
      safePause();
    }
    resetControlsTimeout();
  }, [safePlay, safePause, resetControlsTimeout]);

  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
    video.currentTime = target;
    setCurrentTime(target);
    resetControlsTimeout();
  };

  const unmuteAudio = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setIsMuted(false);
    setShowUnmutePrompt(false);
    if (volume === 0) {
      video.volume = 1;
      setVolume(1);
    }
    resetControlsTimeout();
  }, [volume, resetControlsTimeout]);

  const setVideoVolume = (newVol: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVol;
    setVolume(newVol);
    if (newVol > 0 && isMuted) {
      video.muted = false;
      setIsMuted(false);
      setShowUnmutePrompt(false);
    }
    resetControlsTimeout();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !isMuted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
    if (!nextMuted) {
      setShowUnmutePrompt(false);
    }
    resetControlsTimeout();
  };

  const changePlaybackSpeed = (speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setPlaybackSpeed(speed);
    setActiveMenu('none');
    resetControlsTimeout();
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen();
      } else if ((container as any).webkitRequestFullscreen) {
        (container as any).webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
    resetControlsTimeout();
  };

  const togglePiP = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP not available', e);
    }
  };

  const toggleSubtitles = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextState = !subtitlesEnabled;
    setSubtitlesEnabled(nextState);

    if (video.textTracks && video.textTracks.length > 0) {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = nextState ? 'showing' : 'disabled';
      }
    }
    resetControlsTimeout();
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || isDraggingSeek) return;

    setCurrentTime(video.currentTime);

    if (video.buffered.length > 0 && video.duration > 0) {
      for (let i = video.buffered.length - 1; i >= 0; i--) {
        if (video.buffered.start(i) <= video.currentTime) {
          const pct = (video.buffered.end(i) / video.duration) * 100;
          setBufferedPercent(Math.min(100, Math.max(0, pct)));
          break;
        }
      }
    }
  };

  const handleTimelineScrub = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const target = pos * duration;

    setCurrentTime(target);
    if (videoRef.current) {
      videoRef.current.currentTime = target;
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    setIsDraggingSeek(true);
    handleTimelineScrub(e);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDraggingSeek) {
      handleTimelineScrub(e);
    }
  };

  const handleTouchEnd = () => {
    setIsDraggingSeek(false);
  };

  const handleVideoTouch = (e: React.TouchEvent<HTMLElement>) => {
    const now = Date.now();
    const touch = e.changedTouches[0];
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const width = rect.width;

    if (now - lastTapRef.current.time < 300) {
      if (x < width / 2) {
        seekBy(-10);
        setDoubleTapFeedback('left');
        setTimeout(() => setDoubleTapFeedback(null), 600);
      } else {
        seekBy(10);
        setDoubleTapFeedback('right');
        setTimeout(() => setDoubleTapFeedback(null), 600);
      }
    } else {
      setShowControls((prev) => !prev);
      setActiveMenu('none');
    }
    lastTapRef.current = { time: now, x };
  };

  const showSkipIntro =
    introStart !== undefined &&
    introEnd !== undefined &&
    introEnd > introStart &&
    currentTime >= introStart &&
    currentTime < introEnd;

  const showSkipOutro =
    outroStart !== undefined &&
    outroEnd !== undefined &&
    outroEnd > outroStart &&
    currentTime >= outroStart &&
    currentTime < outroEnd;

  const handleSkipIntro = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current && introEnd > 0) {
      videoRef.current.currentTime = introEnd;
      setCurrentTime(introEnd);
    }
  };

  const handleSkipOutro = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current && outroEnd > 0) {
      videoRef.current.currentTime = outroEnd;
      setCurrentTime(outroEnd);
    }
  };

  const renderVolumeIcon = () => {
    if (isMuted || volume === 0) return <MuteIcon size={20} />;
    if (volume <= 0.33) return <VolumeLowIcon size={20} />;
    if (volume <= 0.66) return <VolumeMediumIcon size={20} />;
    return <VolumeHighIcon size={20} />;
  };

  // Resolutions available based on actual video height (never show 1080p if video resolution is lower)
  const availableResolutions = useMemo(() => {
    const list = ['Auto (Adaptive)'];
    if (videoHeight >= 1080) list.push('1080p HD');
    if (videoHeight >= 720) list.push('720p HD');
    if (videoHeight >= 480) list.push('480p SD');
    list.push('360p SD');
    return list;
  }, [videoHeight]);

  const currentPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={`relative w-full aspect-video bg-[#0a0a0c] select-none overflow-hidden rounded-xl shadow-2xl flex items-center justify-center font-sans ${className}`}
      onMouseMove={resetControlsTimeout}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* HTML5 Video element */}
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="metadata"
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        onTouchEnd={handleVideoTouch}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => {
          if (videoRef.current) {
            setDuration(videoRef.current.duration);
            setVideoHeight(videoRef.current.videoHeight || 1080);
          }
        }}
        onCanPlay={() => {
          setIsBuffering(false);
          streamRetryCountRef.current = 0;
        }}
        onLoadedData={() => {
          setIsBuffering(false);
          streamRetryCountRef.current = 0;
        }}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => {
          setIsBuffering(false);
          setIsPlaying(true);
          setShowPausedOverlay(false);
          streamRetryCountRef.current = 0;
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setHasEnded(true);
          setShowControls(true);
        }}
        onError={async () => {
          // If video is still transcoding or downloading on server, retry transparently
          if (streamRetryCountRef.current < 4) {
            streamRetryCountRef.current += 1;
            setIsBuffering(true);
            setTimeout(() => {
              if (videoRef.current && isMountedRef.current) {
                videoRef.current.load();
                safePlay(true);
              }
            }, 2500);
            return;
          }
          setIsBuffering(false);
          try {
            const probeRes = await fetch(src, { headers: { Range: 'bytes=0-0' } });
            if (!probeRes.ok) {
              const probeData = await probeRes.json().catch(() => null);
              if (probeData?.error) {
                setPlaybackError(`${probeData.error}${probeData.details ? `: ${probeData.details}` : ''}`);
                return;
              }
            }
          } catch {}
          setPlaybackError('Unable to play video or stream interrupted.');
        }}
      >
        {availableSubtitleTracks.map((sub) => (
          <track
            key={sub.index}
            kind="subtitles"
            label={sub.title || `${sub.language?.toUpperCase() || 'SUB'} Subtitles`}
            src={sub.url}
            srcLang={sub.language || 'en'}
            default={subtitlesEnabled && selectedSubtitleTrack === sub.index}
          />
        ))}
        {subtitlesUrl && availableSubtitleTracks.length === 0 && (
          <track
            kind="subtitles"
            label={subtitlesLabel}
            src={subtitlesUrl}
            srcLang="en"
            default={subtitlesEnabled}
          />
        )}
      </video>

      {/* Floating Autoplay Unmute Prompt */}
      {showUnmutePrompt && isPlaying && isMuted && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            unmuteAudio();
          }}
          className="absolute top-4 left-4 z-40 flex items-center gap-2 px-3.5 py-2 rounded-full bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-2xl backdrop-blur-md transition-all hover:scale-105 active:scale-95 cursor-pointer animate-pulse border border-white/20"
        >
          <VolumeHighIcon size={16} />
          <span>Click to Unmute 🔊</span>
        </button>
      )}

      {/* Double Tap Ripple Feedback */}
      {doubleTapFeedback === 'left' && (
        <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none bg-black/60 backdrop-blur-md px-4 py-3 rounded-full animate-ping text-white text-xs font-semibold">
          <RewindIcon size={28} className="text-white mb-1" />
          <span>-10s</span>
        </div>
      )}
      {doubleTapFeedback === 'right' && (
        <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none bg-black/60 backdrop-blur-md px-4 py-3 rounded-full animate-ping text-white text-xs font-semibold">
          <FastForwardIcon size={28} className="text-white mb-1" />
          <span>+10s</span>
        </div>
      )}

      {/* Top Right Floating Action: Report Issue Flag Button */}
      <div
        className={`absolute top-3.5 right-3.5 z-30 transition-all duration-300 ${
          showControls ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1 pointer-events-none'
        }`}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            const video = videoRef.current;
            if (video && !video.paused) {
              video.pause();
              setIsPlaying(false);
            }
            setShowReportModal(true);
          }}
          className="w-8 h-8 md:w-9 md:h-9 rounded-lg bg-black/60 hover:bg-black/85 backdrop-blur-md border border-white/15 hover:border-red-500/60 text-zinc-300 hover:text-red-400 flex items-center justify-center transition shadow-lg cursor-pointer active:scale-95"
          title="Report an Issue"
          aria-label="Report an Issue"
        >
          <ReportFlagIcon size={18} />
        </button>
      </div>

      {/* Buffering Spinner */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px] pointer-events-none z-20">
          <div className="w-12 h-12 rounded-full border-3 border-white/20 border-t-red-600 animate-spin" />
        </div>
      )}

      {/* Playback Error Overlay */}
      {playbackError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md p-6 text-center z-30">
          <div className="w-12 h-12 rounded-full bg-red-950/80 border border-red-500/40 flex items-center justify-center text-red-400 mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <p className="text-white font-medium text-base mb-1">Playback Error</p>
          <p className="text-zinc-400 text-xs max-w-sm mb-4">{playbackError}</p>
          <button
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.load();
                videoRef.current.play().catch(() => {});
              }
            }}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-medium transition cursor-pointer border border-zinc-700 active:scale-95"
          >
            Retry Playback
          </button>
        </div>
      )}

      {/* Prominent Center Play Button when Paused */}
      {!isPlaying && !isBuffering && !playbackError && !hasEnded && !showPausedOverlay && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="absolute inset-0 flex items-center justify-center cursor-pointer z-20 group pointer-events-auto"
        >
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-red-600/90 group-hover:bg-red-600 text-white flex items-center justify-center shadow-2xl shadow-red-950/80 backdrop-blur-md transition-all duration-200 group-hover:scale-110 active:scale-95 border border-white/20">
            <PlayIcon size={32} className="ml-1 text-white" />
          </div>
        </div>
      )}

      {/* Video Ended Replay Button */}
      {hasEnded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-20">
          <button
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.currentTime = 0;
                videoRef.current.play();
                setHasEnded(false);
              }
            }}
            className="p-5 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white shadow-2xl backdrop-blur-lg transition-transform hover:scale-105 active:scale-95 cursor-pointer"
            aria-label="Replay video"
          >
            <PlayIcon size={32} />
          </button>
          <span className="text-zinc-300 text-xs mt-3 font-medium">Replay</span>
        </div>
      )}

      {/* Immersive Pause Overlay (after 7 seconds paused) */}
      {!isPlaying && showPausedOverlay && (
        <div
          onClick={togglePlay}
          className="absolute inset-0 z-30 flex items-center p-8 md:p-16 bg-gradient-to-r from-black/90 via-black/70 to-transparent backdrop-blur-md cursor-pointer animate-fade-in"
        >
          <div className="max-w-xl space-y-3">
            <span className="text-zinc-400 text-xs tracking-wider uppercase">You're watching</span>
            <h2 className="text-white text-2xl md:text-4xl font-extrabold tracking-tight drop-shadow-lg">
              {seriesTitle || title || 'VidFrame Video'}
            </h2>
            {seasonNumber && (
              <p className="text-zinc-300 text-xs md:text-sm font-medium">
                Season {seasonNumber} {episodeNumber ? `• Episode ${episodeNumber}${episodeTitle ? `: ${episodeTitle}` : ''}` : ''}
              </p>
            )}
            {description && (
              <p className="text-zinc-400 text-xs md:text-sm line-clamp-3 leading-relaxed">
                {description}
              </p>
            )}
            <div className="pt-2 flex items-center gap-3">
              <div className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-red-950/50 flex items-center gap-2">
                <PlayIcon size={16} />
                <span>Click to Resume</span>
              </div>
              <span className="absolute bottom-6 right-6 text-zinc-500 text-[11px] font-mono">Paused</span>
            </div>
          </div>
        </div>
      )}

      {/* Skip Intro Button */}
      {showSkipIntro && (
        <button
          onClick={handleSkipIntro}
          className="absolute right-4 bottom-20 md:bottom-16 z-30 flex items-center gap-2 px-4 py-2 rounded-lg bg-black/75 hover:bg-black/90 text-white border border-white/20 shadow-2xl backdrop-blur-md text-xs font-medium transition-all hover:scale-105 active:scale-95 cursor-pointer animate-fade-in"
          aria-label="Skip Intro"
        >
          <SkipIntroOutroIcon size={18} className="text-red-500" />
          <span>Skip Intro</span>
        </button>
      )}

      {/* Skip Outro Button */}
      {showSkipOutro && (
        <button
          onClick={handleSkipOutro}
          className="absolute right-4 bottom-20 md:bottom-16 z-30 flex items-center gap-2 px-4 py-2 rounded-lg bg-black/75 hover:bg-black/90 text-white border border-white/20 shadow-2xl backdrop-blur-md text-xs font-medium transition-all hover:scale-105 active:scale-95 cursor-pointer animate-fade-in"
          aria-label="Skip Outro"
        >
          <SkipIntroOutroIcon size={18} className="text-red-500" />
          <span>Skip Outro</span>
        </button>
      )}

      {/* Settings Popover */}
      {activeMenu !== 'none' && (
        <div
          className="absolute right-4 bottom-16 z-40 w-64 bg-zinc-950/90 border border-zinc-800/80 rounded-xl shadow-2xl backdrop-blur-xl p-2 text-xs text-zinc-300 animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          {activeMenu === 'main' && (
            <div className="space-y-1">
              <div className="px-3 py-2 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                Playback Settings
              </div>
              <button
                onClick={() => setActiveMenu('speed')}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-2.5">
                  <PlaybackSpeedGaugeIcon size={18} className="text-zinc-400" />
                  <span>Playback Speed</span>
                </div>
                <span className="text-zinc-400">{playbackSpeed === 1 ? 'Normal' : `${playbackSpeed}×`}</span>
              </button>

              <button
                onClick={() => setActiveMenu('quality')}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-2.5">
                  <ResolutionHDIcon size={18} className="text-zinc-400" />
                  <span>Resolution</span>
                </div>
                <span className="text-zinc-400">{selectedQuality}</span>
              </button>

              <button
                onClick={() => setActiveMenu('audio')}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-2.5">
                  <AudioTrackIcon size={18} className="text-zinc-400" />
                  <span>Audio Track</span>
                </div>
                <span className="text-zinc-400 truncate max-w-[120px] text-right">
                  {availableAudioTracks[selectedAudioTrack]?.title ||
                    (availableAudioTracks.length > 0 ? `Track ${selectedAudioTrack + 1}` : 'Default (Stereo)')}
                </span>
              </button>

              <button
                onClick={() => setActiveMenu('subtitles')}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/10 transition cursor-pointer text-left"
              >
                <div className="flex items-center gap-2.5">
                  <SubtitlesIcon size={18} className="text-zinc-400" />
                  <span>Subtitles</span>
                </div>
                <span className="text-zinc-400 truncate max-w-[100px] text-right">
                  {subtitlesEnabled && selectedSubtitleTrack !== null
                    ? (availableSubtitleTracks[selectedSubtitleTrack]?.title ||
                       availableSubtitleTracks[selectedSubtitleTrack]?.language?.toUpperCase() ||
                       subtitlesLabel)
                    : (subtitlesEnabled ? subtitlesLabel : 'Off')}
                </span>
              </button>
            </div>
          )}

          {activeMenu === 'speed' && (
            <div>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80 mb-1">
                <button
                  onClick={() => setActiveMenu('main')}
                  className="hover:text-white transition cursor-pointer"
                  aria-label="Back to settings menu"
                >
                  <ChevronLeftIcon size={16} />
                </button>
                <span className="font-semibold text-white">Playback Speed</span>
              </div>
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
                {SPEED_OPTIONS.map((spd) => (
                  <button
                    key={spd}
                    onClick={() => changePlaybackSpeed(spd)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                      playbackSpeed === spd ? 'bg-red-600/20 text-red-400 font-semibold' : 'hover:bg-white/10'
                    }`}
                  >
                    <span>{spd === 1 ? '1.0× (Normal)' : `${spd}×`}</span>
                    {playbackSpeed === spd && <span className="text-red-500 font-bold">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeMenu === 'quality' && (
            <div>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80 mb-1">
                <button
                  onClick={() => setActiveMenu('main')}
                  className="hover:text-white transition cursor-pointer"
                  aria-label="Back to settings menu"
                >
                  <ChevronLeftIcon size={16} />
                </button>
                <span className="font-semibold text-white">Resolution</span>
              </div>
              <div className="space-y-0.5">
                {availableResolutions.map((qual) => (
                  <button
                    key={qual}
                    onClick={() => {
                      setSelectedQuality(qual);
                      setActiveMenu('none');
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                      selectedQuality === qual ? 'bg-red-600/20 text-red-400 font-semibold' : 'hover:bg-white/10'
                    }`}
                  >
                    <span>{qual}</span>
                    {selectedQuality === qual && <span className="text-red-500 font-bold">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeMenu === 'audio' && (
            <div>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80 mb-1">
                <button
                  onClick={() => setActiveMenu('main')}
                  className="hover:text-white transition cursor-pointer"
                  aria-label="Back to settings menu"
                >
                  <ChevronLeftIcon size={16} />
                </button>
                <span className="font-semibold text-white">Audio Track</span>
              </div>
              <div className="space-y-0.5 max-h-56 overflow-y-auto">
                {isLoadingTracks && availableAudioTracks.length === 0 && (
                  <div className="px-3 py-3 text-zinc-400 text-center flex items-center justify-center gap-2">
                    <div className="w-3.5 h-3.5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
                    <span>Detecting audio tracks...</span>
                  </div>
                )}
                {availableAudioTracks.length > 0 ? (
                  availableAudioTracks.map((trk) => (
                    <button
                      key={trk.index}
                      onClick={() => {
                        setSelectedAudioTrack(trk.index);
                        setActiveMenu('none');
                        const video = videoRef.current as any;
                        if (video && video.audioTracks && video.audioTracks.length > trk.index) {
                          for (let i = 0; i < video.audioTracks.length; i++) {
                            video.audioTracks[i].enabled = (i === trk.index);
                          }
                        }
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                        selectedAudioTrack === trk.index ? 'bg-red-600/20 text-red-400 font-semibold' : 'hover:bg-white/10'
                      }`}
                    >
                      <div className="flex flex-col min-w-0 pr-2">
                        <span className="truncate">{trk.title || `Audio Track ${trk.index + 1}`}</span>
                        <span className="text-[10px] text-zinc-500 uppercase font-mono">
                          {trk.language ? trk.language.toUpperCase() : 'STEREO'} {trk.codec ? `• ${trk.codec.toUpperCase()}` : ''}
                        </span>
                      </div>
                      {selectedAudioTrack === trk.index && <span className="text-red-500 font-bold shrink-0">✓</span>}
                    </button>
                  ))
                ) : (
                  <button
                    onClick={() => setActiveMenu('none')}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-red-600/20 text-red-400 font-semibold cursor-pointer text-left"
                  >
                    <span>Default Track (Audio)</span>
                    <span className="text-red-500 font-bold">✓</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {activeMenu === 'subtitles' && (
            <div>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80 mb-1">
                <button
                  onClick={() => setActiveMenu('main')}
                  className="hover:text-white transition cursor-pointer"
                  aria-label="Back to settings menu"
                >
                  <ChevronLeftIcon size={16} />
                </button>
                <span className="font-semibold text-white">Subtitles</span>
              </div>
              <div className="space-y-0.5 max-h-56 overflow-y-auto">
                <button
                  onClick={() => {
                    setSelectedSubtitleTrack(null);
                    setSubtitlesEnabled(false);
                    const video = videoRef.current;
                    if (video && video.textTracks) {
                      for (let i = 0; i < video.textTracks.length; i++) {
                        video.textTracks[i].mode = 'disabled';
                      }
                    }
                    setActiveMenu('none');
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                    !subtitlesEnabled || selectedSubtitleTrack === null
                      ? 'bg-red-600/20 text-red-400 font-semibold'
                      : 'hover:bg-white/10'
                  }`}
                >
                  <span>Off</span>
                  {(!subtitlesEnabled || selectedSubtitleTrack === null) && (
                    <span className="text-red-500 font-bold">✓</span>
                  )}
                </button>

                {availableSubtitleTracks.map((sub) => (
                  <button
                    key={sub.index}
                    onClick={() => {
                      setSelectedSubtitleTrack(sub.index);
                      setSubtitlesEnabled(true);
                      const video = videoRef.current;
                      if (video && video.textTracks) {
                        for (let i = 0; i < video.textTracks.length; i++) {
                          video.textTracks[i].mode = (i === sub.index) ? 'showing' : 'disabled';
                        }
                      }
                      setActiveMenu('none');
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                      subtitlesEnabled && selectedSubtitleTrack === sub.index
                        ? 'bg-red-600/20 text-red-400 font-semibold'
                        : 'hover:bg-white/10'
                    }`}
                  >
                    <div className="flex flex-col min-w-0 pr-2">
                      <span className="truncate">{sub.title || `${sub.language?.toUpperCase() || 'Track'} Subtitles`}</span>
                      {sub.language && (
                        <span className="text-[10px] text-zinc-500 uppercase font-mono">{sub.language}</span>
                      )}
                    </div>
                    {subtitlesEnabled && selectedSubtitleTrack === sub.index && (
                      <span className="text-red-500 font-bold shrink-0">✓</span>
                    )}
                  </button>
                ))}

                {subtitlesUrl && availableSubtitleTracks.length === 0 && (
                  <button
                    onClick={() => {
                      setSelectedSubtitleTrack(0);
                      setSubtitlesEnabled(true);
                      const video = videoRef.current;
                      if (video && video.textTracks && video.textTracks[0]) {
                        video.textTracks[0].mode = 'showing';
                      }
                      setActiveMenu('none');
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition cursor-pointer text-left ${
                      subtitlesEnabled ? 'bg-red-600/20 text-red-400 font-semibold' : 'hover:bg-white/10'
                    }`}
                  >
                    <span>{subtitlesLabel}</span>
                    {subtitlesEnabled && <span className="text-red-500 font-bold">✓</span>}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bottom Control Bar */}
      <div
        className={`absolute bottom-0 inset-x-0 p-3 md:p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-30 transition-all duration-300 ${
          showControls ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Timeline Scrubber */}
        <div
          ref={timelineRef}
          className="group relative w-full h-2 md:h-2.5 flex items-center cursor-pointer mb-3 touch-none"
          onClick={handleTimelineScrub}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="w-full h-1 group-hover:h-2 bg-white/20 rounded-full overflow-hidden transition-all duration-150 relative">
            <div
              className="absolute left-0 top-0 bottom-0 bg-white/40 transition-all duration-200"
              style={{ width: `${bufferedPercent}%` }}
            />
            <div
              className="absolute left-0 top-0 bottom-0 bg-red-600 transition-all duration-75"
              style={{ width: `${currentPercent}%` }}
            />
          </div>
          <div
            className="absolute -translate-x-1/2 w-3.5 h-3.5 md:w-4 md:h-4 bg-red-600 rounded-full shadow-lg border-2 border-white opacity-0 group-hover:opacity-100 md:group-hover:scale-110 transition-all pointer-events-none"
            style={{ left: `${currentPercent}%` }}
          />
        </div>

        {/* Controls Row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 md:gap-2">
            <button
              onClick={togglePlay}
              className="w-10 h-10 md:w-11 md:h-11 flex items-center justify-center rounded-lg text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
            </button>

            <button
              onClick={() => seekBy(-10)}
              className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              aria-label="Rewind 10 seconds"
              title="Rewind 10 seconds"
            >
              <RewindIcon size={20} />
            </button>

            <button
              onClick={() => seekBy(10)}
              className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              aria-label="Fast forward 10 seconds"
              title="Fast forward 10 seconds"
            >
              <FastForwardIcon size={20} />
            </button>

            <div className="group/vol flex items-center gap-1 relative">
              <button
                onClick={toggleMute}
                className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {renderVolumeIcon()}
              </button>
              <div className="hidden md:flex items-center w-0 group-hover/vol:w-20 overflow-hidden transition-all duration-200">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => setVideoVolume(parseFloat(e.target.value))}
                  className="w-16 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-red-600"
                  aria-label="Volume adjustment slider"
                />
              </div>
            </div>

            <div className="text-[11px] md:text-xs text-zinc-300 font-mono tracking-tight ml-1">
              <span>{formatTime(currentTime)}</span>
              <span className="mx-1 text-zinc-500">/</span>
              <span className="text-zinc-400">{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            <button
              onClick={toggleSubtitles}
              className={`w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg transition active:scale-95 cursor-pointer ${
                subtitlesEnabled ? 'text-red-500 bg-red-600/15' : 'text-zinc-300 hover:text-white hover:bg-white/10'
              }`}
              aria-label="Toggle Subtitles"
              title="Subtitles"
            >
              <SubtitlesIcon size={20} />
            </button>

            <button
              onClick={() => setActiveMenu((prev) => (prev === 'none' ? 'main' : 'none'))}
              className={`w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg transition active:scale-95 cursor-pointer ${
                activeMenu !== 'none' ? 'text-red-500 bg-white/10' : 'text-zinc-300 hover:text-white hover:bg-white/10'
              }`}
              aria-label="Settings"
              title="Settings"
            >
              <SettingsIcon size={20} />
            </button>

            {isPiPSupported && (
              <button
                onClick={togglePiP}
                className="hidden sm:flex w-9 h-9 md:w-10 md:h-10 items-center justify-center rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
                aria-label="Picture in Picture"
                title="Picture in Picture"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <rect x="12" y="10" width="8" height="6" rx="1" fill="currentColor" fillOpacity="0.2" />
                </svg>
              </button>
            )}

            <button
              onClick={toggleFullscreen}
              className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-lg text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 transition cursor-pointer"
              aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
              title={isFullscreen ? 'Exit Fullscreen (F)' : 'Enter Fullscreen (F)'}
            >
              {isFullscreen ? <ExitFullscreenIcon size={20} /> : <EnterFullscreenIcon size={20} />}
            </button>
          </div>
        </div>
      </div>

      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        mediaId={mediaId || src.split('/media/')[1]?.split('/stream')[0]}
        mediaTitle={episodeTitle || title || seriesTitle}
      />
    </div>
  );
};
