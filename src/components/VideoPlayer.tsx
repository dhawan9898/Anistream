// VideoPlayer.tsx - Premium Mobile Video Player with HLS, Gestures, & Ani-cli controls
import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play, Pause, RotateCcw, RotateCw, ArrowLeft, Maximize, Minimize, SkipForward,
  Volume2, VolumeX, Check, Loader2, X, Gauge, Lock, LockOpen, Layers, MessageSquareText
} from 'lucide-react';
import type { StreamSource, EpisodeItem } from '../core/aniCliCore';
import { getUserPreferences } from '../services/historyService';
import { getEpisodeSkipIntervals, type SkipInterval } from '../services/aniSkipService';
import './VideoPlayer.css';

const resolvePlayableUrl = (url?: string, _referer?: string): string => {
  if (!url) return '';
  // Return direct URL directly so hls.js can load it without requiring a local proxy server
  return url;
};

interface VideoPlayerProps {
  streamSource: StreamSource;
  animeTitle: string;
  episode: EpisodeItem;
  mode: 'sub' | 'dub';
  onBack: () => void;
  onNextEpisode?: () => void;
  hasNextEpisode?: boolean;
  onProgressUpdate?: (currentTime: number, duration: number) => void;
  initialTime?: number;
  episodeList?: EpisodeItem[];
  onSelectEpisode?: (ep: EpisodeItem) => void;
  // Re-resolves the same episode in the other audio language (sub <-> dub).
  onSwitchMode?: (mode: 'sub' | 'dub') => void;
}

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
// Netflix-style post-play: the "Next Episode" button fills up over this many
// seconds of playback, then advances (when autoplay is on).
const NEXT_EPISODE_COUNTDOWN_SECS = 10;
// Without an outro marker, post-play appears this close to the end.
const POST_PLAY_THRESHOLD_SECS = 20;
const NETFLIX_RED = '#e50914';

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  streamSource,
  animeTitle,
  episode,
  mode,
  onBack,
  onNextEpisode,
  hasNextEpisode,
  onProgressUpdate,
  initialTime = 0,
  episodeList,
  onSelectEpisode,
  onSwitchMode
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [buffered, setBuffered] = useState<number>(0);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [selectedQuality, setSelectedQuality] = useState<string>(streamSource.quality || '1080p');
  const [showAudioPanel, setShowAudioPanel] = useState<boolean>(false);
  const [showSpeedPanel, setShowSpeedPanel] = useState<boolean>(false);
  const [showEpisodeMenu, setShowEpisodeMenu] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [showUnlock, setShowUnlock] = useState<boolean>(false);
  const unlockTimerRef = useRef<number | null>(null);
  // Post-play ("Next Episode" countdown): null while hidden, otherwise 0..1.
  const [postPlayProgress, setPostPlayProgress] = useState<number | null>(null);
  const [inOutro, setInOutro] = useState<boolean>(false);
  const postPlayStartRef = useRef<number | null>(null);
  const postPlayDismissedRef = useRef<boolean>(false);
  const advancedRef = useRef<boolean>(false);
  const episodeGridRef = useRef<HTMLDivElement | null>(null);
  const [volumeIndicator, setVolumeIndicator] = useState<number | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragStartVolumeRef = useRef<number>(1);
  const isDraggingVolumeRef = useRef<boolean>(false);
  const suppressNextTapRef = useRef<boolean>(false);
  const volumeIndicatorTimerRef = useRef<number | null>(null);
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(
    () => streamSource.subtitles.find(s => s.default)?.label ?? streamSource.subtitles[0]?.label ?? null
  );
  const [showSkipIntro, setShowSkipIntro] = useState<boolean>(false);
  const [skippedIntroToast, setSkippedIntroToast] = useState<boolean>(false);
  const [showSkipOutro, setShowSkipOutro] = useState<boolean>(false);
  const [doubleTapFeedback, setDoubleTapFeedback] = useState<'left' | 'right' | null>(null);
  const [videoTrackWarning, setVideoTrackWarning] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [autoSkipIntro, setAutoSkipIntro] = useState<boolean>(false);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(true);
  const [introInterval, setIntroInterval] = useState<SkipInterval | null>(null);
  const [outroInterval, setOutroInterval] = useState<SkipInterval | null>(null);
  const autoSkippedRef = useRef<boolean>(false);
  const introLookupRef = useRef<string | null>(null);

  useEffect(() => {
    getUserPreferences().then(p => {
      setAutoSkipIntro(p.autoSkipIntro);
      setAutoPlayNext(p.autoPlayNext);
    });
  }, []);

  // A new episode/stream means a fresh intro/outro to (maybe) look up and auto-skip.
  useEffect(() => {
    autoSkippedRef.current = false;
    introLookupRef.current = null;
    postPlayStartRef.current = null;
    postPlayDismissedRef.current = false;
    advancedRef.current = false;
    setPostPlayProgress(null);
    setInOutro(false);
    setShowSkipIntro(false);
    setShowSkipOutro(false);
    // Markers from the stream's own sources payload (HiAnime-style) are
    // known up front; AniSkip below only fills in whichever half is missing.
    setIntroInterval(streamSource.intro ?? null);
    setOutroInterval(streamSource.outro ?? null);
    setSelectedQuality(streamSource.quality || '1080p');
    setActiveSubtitle(streamSource.subtitles.find(s => s.default)?.label ?? streamSource.subtitles[0]?.label ?? null);
  }, [streamSource.streamUrl, streamSource.quality, streamSource.subtitles, streamSource.intro, streamSource.outro]);

  // Keep the browser's native text tracks in sync with the chosen caption
  // label - selecting a caption in the menu only updates state, so without
  // this the video would keep whatever track was 'showing' by default.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const label = streamSource.subtitles[i]?.label;
      tracks[i].mode = label && label === activeSubtitle ? 'showing' : 'disabled';
    }
  }, [activeSubtitle, streamSource.subtitles]);

  // Real per-episode opening/ending timestamps only become knowable once we
  // have this episode's actual duration (AniSkip needs it to normalize its
  // timestamps) - so look them up as soon as duration is known, once per
  // stream. No result for a half means we genuinely don't know where it is,
  // so no skip button is offered for it rather than guessing.
  useEffect(() => {
    if (!duration || duration <= 0) return;
    if (introLookupRef.current === streamSource.streamUrl) return;
    introLookupRef.current = streamSource.streamUrl;
    if (streamSource.intro && streamSource.outro) return;

    getEpisodeSkipIntervals(animeTitle, episode.number, duration).then(({ opening, ending }) => {
      if (!streamSource.intro) setIntroInterval(opening);
      if (!streamSource.outro) setOutroInterval(ending);
    });
  }, [duration, streamSource.streamUrl, streamSource.intro, streamSource.outro, animeTitle, episode.number]);

  // Initialize Hls / Video stream
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const rawStreamUrl = streamSource.streamUrl;
    const referer = streamSource.referer || 'https://zokoanime.video/';
    const streamUrl = resolvePlayableUrl(rawStreamUrl, referer);
    setVideoTrackWarning(null);
    setStreamError(null);
    setIsBuffering(false);

    // Only surface no-video-track warning if playback has been running for a few seconds
    // with continuous 0x0 video dimensions (to avoid false alarms during initial frame decoding)
    const checkVideoTrack = () => {
      if (video.videoWidth === 0 && video.videoHeight === 0 && !video.paused && video.currentTime > 2) {
        console.warn('[VideoPlayer] Playback has no video track (videoWidth/videoHeight are 0). streamUrl:', streamUrl);
        setVideoTrackWarning('No video track in this stream (audio only or unsupported codec).');
      } else if (video.videoWidth > 0 && video.videoHeight > 0) {
        setVideoTrackWarning(null);
      }
    };
    video.addEventListener('timeupdate', checkVideoTrack);

    // "waiting" fires whenever playback stalls for lack of data - whether
    // that's the very first load or a mid-episode network hiccup - and
    // "playing"/"canplay" fire the instant it can resume, so a spinner tied
    // to these always reflects "is it actually stuck right now".
    const handleWaiting = () => setIsBuffering(true);
    const handleResumed = () => setIsBuffering(false);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handleResumed);
    video.addEventListener('canplay', handleResumed);

    const isMp4 = streamUrl.toLowerCase().split('?')[0].endsWith('.mp4');

    if (isMp4) {
      video.src = streamUrl;
      video.load();
      video.addEventListener('loadedmetadata', () => {
        if (initialTime > 0) {
          video.currentTime = initialTime;
        }
        video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      });
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        // These are VOD episodes, not a live broadcast - lowLatencyMode
        // trims buffers to chase the live edge, which only makes stalls
        // more likely here for no benefit. A bigger forward buffer instead
        // gives real cushion against network hiccups.
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1000 * 1000,
        xhrSetup: (xhr, _url) => {
          // CapacitorHttp intercepts this and allows setting custom headers like Referer
          xhr.setRequestHeader('Referer', referer);
        }
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[VideoPlayer] Manifest parsed, levels count:', data.levels.length);
        if (data.levels.length > 0 && data.levels.every(l => !l.videoCodec && !l.width)) {
          setVideoTrackWarning('No video track in this stream (audio only or unsupported codec).');
        }
        if (initialTime > 0) {
          video.currentTime = initialTime;
        }
        video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      });

      let networkRetry = 0;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[VideoPlayer] hls.js error:', data.type, data.details, 'fatal:', data.fatal);
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetry < 1) {
            networkRetry++;
            hls.startLoad();
          } else {
            console.warn('[VideoPlayer] HLS stream unrecoverable');
            hls.destroy();
            hlsRef.current = null;
            setIsPlaying(false);
            setStreamError('This stream failed to load.');
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari/iOS WebView)
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', () => {
        if (initialTime > 0) {
          video.currentTime = initialTime;
        }
        video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      });
    }

    return () => {
      video.removeEventListener('timeupdate', checkVideoTrack);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handleResumed);
      video.removeEventListener('canplay', handleResumed);
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [streamSource.streamUrl, streamSource.referer, initialTime]);

  // Opening the episode window centers the grid on the playing episode, so
  // late episodes of a long series don't need a manual scroll to find.
  useEffect(() => {
    if (!showEpisodeMenu) return;
    const grid = episodeGridRef.current;
    const current = grid?.querySelector<HTMLElement>('[data-current]');
    if (grid && current) {
      grid.scrollTop = current.offsetTop - grid.clientHeight / 2 + current.clientHeight / 2;
    }
  }, [showEpisodeMenu]);

  // Controls auto-hide logic
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimer.current) {
      window.clearTimeout(hideControlsTimer.current);
    }
    if (isPlaying) {
      hideControlsTimer.current = window.setTimeout(() => {
        setShowControls(false);
      }, 3500);
    }
  }, [isPlaying]);

  const changeSpeed = (rate: number) => {
    const video = videoRef.current;
    setPlaybackRate(rate);
    if (video) {
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
    }
  };

  const lockScreen = () => {
    setIsLocked(true);
    setShowControls(false);
    setShowEpisodeMenu(false);
  };

  const unlockScreen = () => {
    setIsLocked(false);
    setShowUnlock(false);
    if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
    resetControlsTimer();
  };

  const playNextEpisode = () => {
    if (advancedRef.current || !onNextEpisode) return;
    advancedRef.current = true;
    onNextEpisode();
  };

  const dismissPostPlay = () => {
    postPlayDismissedRef.current = true;
    setPostPlayProgress(null);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
    resetControlsTimer();
  };

  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.currentTime + seconds, video.duration || 0));
    resetControlsTimer();
  };

  // Seeks to an absolute timestamp, clamped to the known duration (falls
  // back to just clamping at 0 if duration isn't known yet).
  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const max = video.duration && isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(seconds, max));
  };

  const skipIntro = () => {
    if (!introInterval) return;
    seekTo(introInterval.end);
    setShowSkipIntro(false);
    resetControlsTimer();
  };

  const skipOutro = () => {
    if (!outroInterval) return;
    seekTo(outroInterval.end);
    setShowSkipOutro(false);
    resetControlsTimer();
  };

  // Switches to a different quality rendition, preserving playback position
  // and play/pause state. Works whether the current/new source is HLS or a
  // direct MP4 (the two are not always the same across qualities).
  const switchQuality = (item: { quality: string; url: string }) => {
    const video = videoRef.current;
    if (!video || !item.url) return;

    setSelectedQuality(item.quality);

    const prevTime = video.currentTime;
    const wasPlaying = !video.paused;
    const newUrl = resolvePlayableUrl(item.url, streamSource.referer);
    const isNewMp4 = newUrl.includes('.mp4') || !newUrl.includes('.m3u8');

    const resume = () => {
      video.currentTime = prevTime;
      video.playbackRate = playbackRate;
      if (wasPlaying) video.play().catch(() => {});
    };

    if (isNewMp4) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.src = newUrl;
      video.addEventListener('loadedmetadata', resume, { once: true });
      video.load();
    } else if (hlsRef.current) {
      hlsRef.current.loadSource(newUrl);
      hlsRef.current.once(Hls.Events.MANIFEST_PARSED, resume);
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        backBufferLength: 90,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1000 * 1000,
        xhrSetup: (xhr) => xhr.setRequestHeader('Referer', streamSource.referer)
      });
      hls.loadSource(newUrl);
      hls.attachMedia(video);
      hlsRef.current = hls;
      hls.once(Hls.Events.MANIFEST_PARSED, resume);
    } else {
      video.src = newUrl;
      video.addEventListener('loadedmetadata', resume, { once: true });
    }
  };

  // Double tap to seek (left side: -10s, right side: +10s)
  const handleTap = (e: React.MouseEvent<HTMLDivElement>) => {
    // A volume-swipe gesture just ended on this same touch sequence - the
    // browser still fires a click after touchend, which would otherwise
    // toggle the controls or register as a tap right after dragging.
    if (suppressNextTapRef.current) {
      suppressNextTapRef.current = false;
      return;
    }

    // Locked: taps only reveal the unlock button, nothing else reacts.
    if (isLocked) {
      setShowUnlock(true);
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = window.setTimeout(() => setShowUnlock(false), 3000);
      return;
    }

    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;

    if (now - lastTapRef.current.time < 300) {
      // Double tap detected
      if (x < width * 0.4) {
        seekBy(-10);
        setDoubleTapFeedback('left');
        setTimeout(() => setDoubleTapFeedback(null), 600);
      } else if (x > width * 0.6) {
        seekBy(10);
        setDoubleTapFeedback('right');
        setTimeout(() => setDoubleTapFeedback(null), 600);
      }
    } else {
      // Single tap toggle controls
      setShowControls(prev => !prev);
      resetControlsTimer();
    }
    lastTapRef.current = { time: now, x };
  };

  // Vertical swipe on the right half of the screen adjusts volume (Netflix/
  // native-player-style gesture). Requires a real drag past a small jitter
  // threshold before it takes over, so it never eats an ordinary tap.
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    if (isLocked || x < rect.width * 0.5) {
      dragStartYRef.current = null;
      return;
    }
    dragStartYRef.current = touch.clientY;
    dragStartVolumeRef.current = videoRef.current?.volume ?? 1;
    isDraggingVolumeRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (dragStartYRef.current === null) return;
    const touch = e.touches[0];
    const deltaY = dragStartYRef.current - touch.clientY;
    const rect = e.currentTarget.getBoundingClientRect();

    if (!isDraggingVolumeRef.current) {
      if (Math.abs(deltaY) < 12) return; // jitter guard
      isDraggingVolumeRef.current = true;
    }

    const video = videoRef.current;
    if (!video) return;
    const newVolume = Math.max(0, Math.min(1, dragStartVolumeRef.current + deltaY / rect.height));
    video.volume = newVolume;
    video.muted = newVolume === 0;
    setVolumeIndicator(Math.round(newVolume * 100));
    if (volumeIndicatorTimerRef.current) window.clearTimeout(volumeIndicatorTimerRef.current);
  };

  const handleTouchEnd = () => {
    dragStartYRef.current = null;
    if (isDraggingVolumeRef.current) {
      isDraggingVolumeRef.current = false;
      suppressNextTapRef.current = true;
      volumeIndicatorTimerRef.current = window.setTimeout(() => setVolumeIndicator(null), 500);
    }
  };

  // Time & progress tracker
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);

    // Offer the skip (or auto-skip) only inside this episode's real,
    // looked-up opening interval - if we never found one, introInterval
    // stays null and we never show a button or guess a timestamp.
    const inIntroWindow = !!introInterval
      && video.currentTime >= introInterval.start
      && video.currentTime < introInterval.end;

    if (inIntroWindow && autoSkipIntro && !autoSkippedRef.current) {
      autoSkippedRef.current = true;
      seekTo(introInterval!.end);
      setShowSkipIntro(false);
      setSkippedIntroToast(true);
      setTimeout(() => setSkippedIntroToast(false), 1800);
    } else {
      setShowSkipIntro(inIntroWindow && !autoSkipIntro);
    }

    // Same idea for the ending - real per-episode data only, manual skip
    // only (there's no "auto-skip outro" preference to honor here).
    const inOutroWindow = !!outroInterval
      && video.currentTime >= outroInterval.start
      && video.currentTime < outroInterval.end;
    setShowSkipOutro(inOutroWindow);
    setInOutro(inOutroWindow);

    // Netflix post-play: once the credits start (or, with no outro marker,
    // near the very end) offer the next episode with a filling countdown
    // that advances on its own when autoplay is on. The countdown runs on
    // playback time, so pausing pauses it too.
    const total = video.duration && isFinite(video.duration) ? video.duration : 0;
    const nearEnd = total > 0 && total - video.currentTime <= POST_PLAY_THRESHOLD_SECS;
    const wantPostPlay = !!hasNextEpisode && !!onNextEpisode && !postPlayDismissedRef.current
      && (inOutroWindow || nearEnd);
    if (wantPostPlay) {
      if (postPlayStartRef.current === null || video.currentTime < postPlayStartRef.current) {
        postPlayStartRef.current = video.currentTime;
      }
      const progress = Math.min(1, (video.currentTime - postPlayStartRef.current) / NEXT_EPISODE_COUNTDOWN_SECS);
      setPostPlayProgress(progress);
      if (progress >= 1 && autoPlayNext) playNextEpisode();
    } else {
      postPlayStartRef.current = null;
      setPostPlayProgress(null);
    }

    // Buffer progress
    if (video.buffered.length > 0) {
      setBuffered(video.buffered.end(video.buffered.length - 1));
    }

    onProgressUpdate?.(video.currentTime, video.duration || 0);
  };

  // HLS/MSE streams can report NaN duration when 'loadedmetadata' first fires
  // (it only fires once); the real duration arrives later via 'durationchange'.
  const handleDurationChange = () => {
    if (videoRef.current && isFinite(videoRef.current.duration)) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleVideoError = () => {
    console.warn('[VideoPlayer] Native video playback error');
    setIsPlaying(false);
    setStreamError('This stream failed to load.');
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
    resetControlsTimer();
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      try {
        await container.requestFullscreen();
        setIsFullscreen(true);
      } catch {
        // Fallback for mobile browser fullscreens
      }
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const formatTime = (secs: number) => {
    if (!isFinite(secs) || secs < 0) secs = 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const mm = h > 0 ? m.toString().padStart(2, '0') : m.toString();
    return `${h > 0 ? `${h}:` : ''}${mm}:${s.toString().padStart(2, '0')}`;
  };

  // Quality choices only when the scraper gave genuinely different URLs -
  // the same URL under several labels is not a real choice.
  const qualityOptions = streamSource.qualities || [];
  const hasQualityChoice = new Set(qualityOptions.map(q => q.url)).size > 1;

  const episodeLabel = episode.title && !/^episode\s*\d+/i.test(episode.title)
    ? `E${episode.number} · ${episode.title}`
    : `E${episode.number}`;
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const anyPanelOpen = showAudioPanel || showSpeedPanel || showEpisodeMenu;
  const controlsVisible = showControls && !isLocked && !anyPanelOpen;

  const bottomAction = (
    key: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void
  ) => (
    <button
      key={key}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="interactive nf-action"
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  // Skip / post-play buttons sit just above the bottom bar while the
  // controls are up, and drop to the corner when they're hidden.
  const cornerBottom = controlsVisible ? 'calc(var(--safe-bottom) + 118px)' : 'calc(var(--safe-bottom) + 32px)';

  return (
    <div
      ref={containerRef}
      className={`nf-player ${controlsVisible ? 'nf-controls-on' : ''}`}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#000',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
      onClick={handleTap}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
        onError={handleVideoError}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          if (autoPlayNext && hasNextEpisode) playNextEpisode();
        }}
      >
        {streamSource.subtitles.map((track, i) => (
          <track
            key={i}
            kind="subtitles"
            label={track.label}
            src={resolvePlayableUrl(track.src, streamSource.referer)}
            default={track.default}
          />
        ))}
      </video>

      {/* Buffering spinner - Netflix red ring */}
      {isBuffering && !streamError && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 15,
            pointerEvents: 'none'
          }}
        >
          <Loader2 size={52} color={NETFLIX_RED} className="animate-spin" />
        </div>
      )}

      {/* No-video-track warning (audio plays, no picture) */}
      {videoTrackWarning && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="nf-dialog"
          style={{ pointerEvents: 'none' }}
        >
          <span style={{ fontSize: '14px', fontWeight: 700 }}>{videoTrackWarning}</span>
          <span style={{ fontSize: '12px', color: '#b3b3b3' }}>Audio is playing, but this server sent no watchable video track. Try again or pick a different episode/server.</span>
        </div>
      )}

      {/* Playback failure */}
      {streamError && (
        <div onClick={(e) => e.stopPropagation()} className="nf-dialog">
          <span style={{ fontSize: '15px', fontWeight: 700 }}>{streamError}</span>
          <span style={{ fontSize: '12px', color: '#b3b3b3' }}>The server may be blocking it or the format isn't supported. Try another episode or server.</span>
          <button onClick={onBack} className="interactive nf-btn-white" style={{ marginTop: '6px' }}>
            Go Back
          </button>
        </div>
      )}

      {/* Volume swipe indicator (right-side vertical drag) */}
      {volumeIndicator !== null && (
        <div className="nf-indicator" style={{ right: '10%' }}>
          {volumeIndicator === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}
          <div className="nf-indicator-track">
            <div style={{ height: `${volumeIndicator}%` }} />
          </div>
        </div>
      )}

      {/* Double tap ripple feedback */}
      {doubleTapFeedback && (
        <div
          className="nf-ripple"
          style={doubleTapFeedback === 'left' ? { left: '12%' } : { right: '12%' }}
        >
          <div className="nf-seek-icon">
            {doubleTapFeedback === 'left' ? <RotateCcw size={40} strokeWidth={1.6} /> : <RotateCw size={40} strokeWidth={1.6} />}
            <span>10</span>
          </div>
        </div>
      )}

      {/* ---------- Top bar: back | title | fullscreen ---------- */}
      <div
        className="nf-top"
        style={{ opacity: controlsVisible ? 1 : 0, pointerEvents: controlsVisible ? 'auto' : 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onBack} className="interactive nf-icon-btn" aria-label="Back">
          <ArrowLeft size={28} />
        </button>
        <div className="nf-title">
          <span className="nf-title-main">{animeTitle}</span>
          <span className="nf-title-sub">
            {episodeLabel}
            {mode === 'dub' ? ' · Dub' : ''}
            {streamSource.isFallback ? ' · DEMO - SOURCE UNAVAILABLE' : ''}
          </span>
        </div>
        <button onClick={toggleFullscreen} className="interactive nf-icon-btn" aria-label="Fullscreen">
          {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
        </button>
      </div>

      {/* ---------- Center transport: -10 | play/pause | +10 ---------- */}
      <div
        className="nf-center"
        style={{ opacity: controlsVisible ? 1 : 0, pointerEvents: controlsVisible ? 'auto' : 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={() => seekBy(-10)} className="interactive nf-icon-btn" aria-label="Back 10 seconds">
          <div className="nf-seek-icon">
            <RotateCcw size={46} strokeWidth={1.6} />
            <span>10</span>
          </div>
        </button>
        <button onClick={togglePlay} className="interactive nf-icon-btn" aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying
            ? <Pause size={64} fill="#fff" strokeWidth={0} />
            : <Play size={64} fill="#fff" strokeWidth={0} />}
        </button>
        <button onClick={() => seekBy(10)} className="interactive nf-icon-btn" aria-label="Forward 10 seconds">
          <div className="nf-seek-icon">
            <RotateCw size={46} strokeWidth={1.6} />
            <span>10</span>
          </div>
        </button>
      </div>

      {/* ---------- Bottom: red seek bar + remaining time, action row ---------- */}
      <div
        className="nf-bottom"
        style={{ opacity: controlsVisible ? 1 : 0, pointerEvents: controlsVisible ? 'auto' : 'none' }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <div className="nf-seek-row">
          <div className="nf-seek">
            <div className="nf-seek-track" />
            <div className="nf-seek-buffered" style={{ width: `${bufferedPct}%` }} />
            <div className="nf-seek-played" style={{ width: `${progressPct}%` }} />
            <div className="nf-seek-thumb" style={{ left: `${progressPct}%` }} />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              aria-label="Seek"
            />
          </div>
          <span className="nf-time">{formatTime(Math.max(0, duration - currentTime))}</span>
        </div>

        <div className="nf-actions">
          {bottomAction('speed', <Gauge size={22} />, `Speed (${playbackRate}x)`, () => setShowSpeedPanel(true))}
          {bottomAction('lock', <Lock size={22} />, 'Lock', lockScreen)}
          {episodeList && episodeList.length > 1 && onSelectEpisode &&
            bottomAction('episodes', <Layers size={22} />, 'Episodes', () => setShowEpisodeMenu(true))}
          {bottomAction('audio', <MessageSquareText size={22} />, 'Audio & Subtitles', () => setShowAudioPanel(true))}
          {hasNextEpisode && onNextEpisode &&
            bottomAction('next', <SkipForward size={22} />, 'Next Ep.', playNextEpisode)}
        </div>
      </div>

      {/* ---------- Skip Intro / Skip Outro / post-play (always reachable,
          even with the controls hidden) ---------- */}
      {!isLocked && !anyPanelOpen && (showSkipIntro || showSkipOutro || skippedIntroToast || postPlayProgress !== null) && (
        <div
          className="nf-corner"
          style={{ bottom: cornerBottom }}
          onClick={(e) => e.stopPropagation()}
        >
          {skippedIntroToast && (
            <div className="nf-skip" style={{ pointerEvents: 'none' }}>
              <span>Intro skipped</span>
            </div>
          )}
          {showSkipIntro && (
            <button onClick={skipIntro} className="interactive nf-skip">
              <SkipForward size={18} fill="#fff" />
              <span>Skip Intro</span>
            </button>
          )}
          {showSkipOutro && (
            <button onClick={skipOutro} className="interactive nf-skip">
              <SkipForward size={18} fill="#fff" />
              <span>Skip Outro</span>
            </button>
          )}
          {postPlayProgress !== null && !inOutro && (
            <button onClick={dismissPostPlay} className="interactive nf-skip">
              <span>Watch Credits</span>
            </button>
          )}
          {postPlayProgress !== null && (
            <button onClick={playNextEpisode} className="interactive nf-next">
              <div
                className="nf-next-fill"
                style={{ width: `${autoPlayNext ? postPlayProgress * 100 : 0}%` }}
              />
              <Play size={18} fill="#000" strokeWidth={0} />
              <span>Next Episode</span>
            </button>
          )}
        </div>
      )}

      {/* ---------- Screen lock ---------- */}
      {isLocked && showUnlock && (
        <div className="nf-unlock" onClick={(e) => e.stopPropagation()}>
          <button onClick={unlockScreen} className="interactive nf-unlock-btn" aria-label="Unlock screen">
            <LockOpen size={26} />
          </button>
          <span>Screen Locked</span>
          <span style={{ fontSize: '12px', color: '#b3b3b3', fontWeight: 500 }}>Tap to unlock</span>
        </div>
      )}

      {/* ---------- Playback speed panel ---------- */}
      {showSpeedPanel && (
        <div
          className="nf-panel"
          onClick={(e) => { e.stopPropagation(); setShowSpeedPanel(false); }}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <button onClick={() => setShowSpeedPanel(false)} className="interactive nf-panel-close" aria-label="Close">
            <X size={28} />
          </button>
          <div className="nf-speed" onClick={(e) => e.stopPropagation()}>
            <h3>Playback Speed</h3>
            <div className="nf-speed-line">
              <div className="nf-speed-rail" />
              {PLAYBACK_SPEEDS.map(rate => (
                <button
                  key={rate}
                  onClick={() => changeSpeed(rate)}
                  className={`nf-speed-stop ${rate === playbackRate ? 'active' : ''}`}
                >
                  <span className="nf-speed-dot" />
                  <span className="nf-speed-label">{rate}x{rate === 1 ? ' (Normal)' : ''}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------- Audio & Subtitles panel ---------- */}
      {showAudioPanel && (
        <div
          className="nf-panel"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <button onClick={() => setShowAudioPanel(false)} className="interactive nf-panel-close" aria-label="Close">
            <X size={28} />
          </button>
          <div className="nf-columns">
            <div className="nf-column">
              <h3>Audio</h3>
              {(['sub', 'dub'] as const).map(m => {
                const active = m === mode;
                const disabled = !active && !onSwitchMode;
                return (
                  <button
                    key={m}
                    disabled={disabled}
                    onClick={() => {
                      if (active || !onSwitchMode) return;
                      setShowAudioPanel(false);
                      onSwitchMode(m);
                    }}
                    className={`nf-option ${active ? 'active' : ''}`}
                  >
                    <span className="nf-check">{active && <Check size={18} />}</span>
                    {m === 'sub' ? 'Japanese [Original]' : 'English (Dub)'}
                  </button>
                );
              })}
            </div>
            <div className="nf-column">
              <h3>Subtitles</h3>
              <button
                onClick={() => setActiveSubtitle(null)}
                className={`nf-option ${activeSubtitle === null ? 'active' : ''}`}
              >
                <span className="nf-check">{activeSubtitle === null && <Check size={18} />}</span>
                Off
              </button>
              {streamSource.subtitles.map((track) => (
                <button
                  key={track.label}
                  onClick={() => setActiveSubtitle(track.label)}
                  className={`nf-option ${activeSubtitle === track.label ? 'active' : ''}`}
                >
                  <span className="nf-check">{activeSubtitle === track.label && <Check size={18} />}</span>
                  {track.label}
                </button>
              ))}
            </div>
            {hasQualityChoice && (
              <div className="nf-column">
                <h3>Video Quality</h3>
                {qualityOptions.map((item) => (
                  <button
                    key={item.quality}
                    onClick={() => switchQuality(item)}
                    className={`nf-option ${selectedQuality === item.quality ? 'active' : ''}`}
                  >
                    <span className="nf-check">{selectedQuality === item.quality && <Check size={18} />}</span>
                    {item.quality}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------- Episodes (floating window) ---------- */}
      {showEpisodeMenu && episodeList && onSelectEpisode && (
        <div
          className="nf-panel nf-panel-center"
          onClick={(e) => {
            e.stopPropagation();
            setShowEpisodeMenu(false);
          }}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <div className="nf-episodes animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <div className="nf-episodes-head">
              <div>
                <div style={{ fontSize: '16px', fontWeight: 800 }}>Episodes</div>
                <div style={{ fontSize: '12px', color: '#b3b3b3', marginTop: '2px' }}>
                  {animeTitle} · {episodeList.length} episodes
                </div>
              </div>
              <button onClick={() => setShowEpisodeMenu(false)} className="interactive nf-icon-btn" aria-label="Close episode list">
                <X size={24} />
              </button>
            </div>
            <div ref={episodeGridRef} className="nf-episodes-grid">
              {episodeList.map((ep) => {
                const isCurrent = ep.id === episode.id;
                return (
                  <button
                    key={ep.id}
                    data-current={isCurrent || undefined}
                    title={ep.title}
                    onClick={() => {
                      setShowEpisodeMenu(false);
                      if (!isCurrent) onSelectEpisode(ep);
                    }}
                    className={`interactive nf-ep ${isCurrent ? 'active' : ''}`}
                  >
                    {ep.number}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
