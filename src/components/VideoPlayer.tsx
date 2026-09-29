// VideoPlayer.tsx - Premium Mobile Video Player with HLS, Gestures, & Ani-cli controls
import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play, Pause, RotateCcw, RotateCw, ArrowLeft, Settings,
  Subtitles, Maximize, Minimize, SkipForward, FastForward, Volume2, VolumeX,
  ListVideo, Check, Loader2
} from 'lucide-react';
import type { StreamSource, EpisodeItem } from '../core/aniCliCore';
import { getUserPreferences } from '../services/historyService';
import { getEpisodeSkipIntervals, type SkipInterval } from '../services/aniSkipService';

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
}

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
  onSelectEpisode
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
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState<boolean>(false);
  const [showEpisodeMenu, setShowEpisodeMenu] = useState<boolean>(false);
  const [volumeIndicator, setVolumeIndicator] = useState<number | null>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragStartVolumeRef = useRef<number>(1);
  const isDraggingVolumeRef = useRef<boolean>(false);
  const suppressNextTapRef = useRef<boolean>(false);
  const volumeIndicatorTimerRef = useRef<number | null>(null);
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(
    () => streamSource.subtitles.find(s => s.default)?.label ?? streamSource.subtitles[0]?.label ?? null
  );
  const [isMuted, setIsMuted] = useState<boolean>(false);
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
    setShowSkipIntro(false);
    setShowSkipOutro(false);
    setIntroInterval(null);
    setOutroInterval(null);
    setSelectedQuality(streamSource.quality || '1080p');
    setActiveSubtitle(streamSource.subtitles.find(s => s.default)?.label ?? streamSource.subtitles[0]?.label ?? null);
  }, [streamSource.streamUrl, streamSource.quality, streamSource.subtitles]);

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

    getEpisodeSkipIntervals(animeTitle, episode.number, duration).then(({ opening, ending }) => {
      setIntroInterval(opening);
      setOutroInterval(ending);
    });
  }, [duration, streamSource.streamUrl, animeTitle, episode.number]);

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

  // Controls auto-hide logic
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimer.current) {
      window.clearTimeout(hideControlsTimer.current);
    }
    if (isPlaying) {
      hideControlsTimer.current = window.setTimeout(() => {
        setShowControls(false);
        setShowQualityMenu(false);
        setShowSubtitleMenu(false);
        setShowEpisodeMenu(false);
      }, 3500);
    }
  }, [isPlaying]);

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
    setShowQualityMenu(false);

    const prevTime = video.currentTime;
    const wasPlaying = !video.paused;
    const newUrl = resolvePlayableUrl(item.url, streamSource.referer);
    const isNewMp4 = newUrl.includes('.mp4') || !newUrl.includes('.m3u8');

    const resume = () => {
      video.currentTime = prevTime;
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
    if (x < rect.width * 0.5) {
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
    setIsMuted(newVolume === 0);
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
    if (isNaN(secs)) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div 
      ref={containerRef}
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
          if (autoPlayNext && hasNextEpisode && onNextEpisode) {
            onNextEpisode();
          }
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

      {/* Buffering spinner - shown whenever the video stalls for lack of
          data (initial load or a mid-episode network hiccup), hidden the
          instant it can resume, so a stall always reads as "still loading"
          rather than a frozen player. */}
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
          <Loader2 size={48} color="#fff" className="animate-spin" />
        </div>
      )}

      {/* No-video-track warning (audio plays, no picture) */}
      {videoTrackWarning && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '10px',
            padding: '20px 24px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(0,0,0,0.75)',
            color: '#f8fafc',
            textAlign: 'center',
            maxWidth: '80%',
            zIndex: 20,
            pointerEvents: 'none'
          }}
        >
          <span style={{ fontSize: '14px', fontWeight: 700 }}>{videoTrackWarning}</span>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>Audio is playing, but this server sent no watchable video track. Try again or pick a different episode/server.</span>
        </div>
      )}

      {/* Playback failure - shown instead of silently substituting an
          unrelated placeholder video, so a broken stream reads as broken. */}
      {streamError && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '10px',
            padding: '24px 28px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(0,0,0,0.8)',
            color: '#f8fafc',
            textAlign: 'center',
            maxWidth: '80%',
            zIndex: 20
          }}
        >
          <span style={{ fontSize: '15px', fontWeight: 700 }}>{streamError}</span>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>The server may be blocking it or the format isn't supported. Try another episode or server.</span>
          <button
            onClick={onBack}
            className="interactive glass-pill"
            style={{
              marginTop: '6px',
              padding: '9px 20px',
              borderRadius: 'var(--radius-full)',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 700
            }}
          >
            Go Back
          </button>
        </div>
      )}

      {/* Volume swipe indicator (right-side vertical drag) */}
      {volumeIndicator !== null && (
        <div style={{
          position: 'absolute',
          right: '10%',
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          color: '#fff',
          backgroundColor: 'rgba(0,0,0,0.6)',
          padding: '16px 20px',
          borderRadius: 'var(--radius-md)',
          pointerEvents: 'none',
          zIndex: 15
        }}>
          {volumeIndicator === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}
          <span style={{ fontSize: '13px', fontWeight: 700 }}>{volumeIndicator}%</span>
        </div>
      )}

      {/* Double Tap Visual Ripple Feedback */}
      {doubleTapFeedback === 'left' && (
        <div style={{
          position: 'absolute',
          left: '12%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          color: '#fff',
          backgroundColor: 'rgba(0,0,0,0.6)',
          padding: '16px 24px',
          borderRadius: '50px',
          pointerEvents: 'none',
          animation: 'fadeIn 0.2s ease-out'
        }}>
          <RotateCcw size={28} color="#6366f1" />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>-10s</span>
        </div>
      )}
      {doubleTapFeedback === 'right' && (
        <div style={{
          position: 'absolute',
          right: '12%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          color: '#fff',
          backgroundColor: 'rgba(0,0,0,0.6)',
          padding: '16px 24px',
          borderRadius: '50px',
          pointerEvents: 'none',
          animation: 'fadeIn 0.2s ease-out'
        }}>
          <RotateCw size={28} color="#6366f1" />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>+10s</span>
        </div>
      )}

      {/* Skip Intro Floating Pill - jumps to a fixed timestamp (not a
          relative +Ns hop), so it actually clears the opening wherever
          playback happens to be when tapped. */}
      {showSkipIntro && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            skipIntro();
          }}
          className="interactive glass-pill"
          style={{
            position: 'absolute',
            bottom: '110px',
            right: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 18px',
            borderRadius: 'var(--radius-full)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 700,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            zIndex: 10
          }}
        >
          <FastForward size={16} />
          <span>Skip Intro</span>
        </button>
      )}

      {/* Auto-skip confirmation toast (shown instead of the button when the
          "Auto-Skip Intro" setting is on). */}
      {skippedIntroToast && (
        <div
          className="glass-pill animate-pop-in"
          style={{
            position: 'absolute',
            bottom: '110px',
            right: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 18px',
            borderRadius: 'var(--radius-full)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 700,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            zIndex: 10,
            pointerEvents: 'none'
          }}
        >
          <FastForward size={16} />
          <span>Intro skipped</span>
        </div>
      )}

      {/* Skip Outro Floating Pill - same idea as Skip Intro, jumps to the
          real per-episode ending timestamp when one was found. */}
      {showSkipOutro && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            skipOutro();
          }}
          className="interactive glass-pill"
          style={{
            position: 'absolute',
            bottom: '110px',
            right: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 18px',
            borderRadius: 'var(--radius-full)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 700,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            zIndex: 10
          }}
        >
          <FastForward size={16} />
          <span>Skip Outro</span>
        </button>
      )}

      {/* Controls Overlay */}
      <div 
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.1) 40%, rgba(0,0,0,0.1) 60%, rgba(0,0,0,0.92) 100%)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 'calc(var(--safe-top) + 16px) 20px calc(var(--safe-bottom) + 16px) 20px',
          opacity: showControls ? 1 : 0,
          pointerEvents: showControls ? 'auto' : 'none',
          transition: 'opacity 0.25s ease'
        }}
        onClick={(e) => {
          e.stopPropagation();
          setShowQualityMenu(false);
          setShowSubtitleMenu(false);
          setShowEpisodeMenu(false);
        }}
      >
        {/* Top Header Bar - Netflix keeps this minimal: back + title only.
            Subtitles/quality/episodes live in a toolbar near the seek bar. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <button
            onClick={onBack}
            className="interactive glass-pill"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              color: '#fff'
            }}
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {animeTitle}
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>Ep {episode.number}</span>
              <span style={{
                fontSize: '10px',
                fontWeight: 700,
                backgroundColor: mode === 'sub' ? '#6366f1' : '#a855f7',
                color: '#fff',
                padding: '1px 6px',
                borderRadius: '4px'
              }}>
                {mode.toUpperCase()}
              </span>
              {streamSource.isFallback && (
                <span style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  backgroundColor: 'var(--accent-danger, #ef4444)',
                  color: '#fff',
                  padding: '1px 6px',
                  borderRadius: '4px'
                }}>
                  DEMO - SOURCE UNAVAILABLE
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Center Playback Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '36px' }}>
          <button
            onClick={() => seekBy(-10)}
            className="interactive glass-pill"
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              border: 'none'
            }}
          >
            <RotateCcw size={22} />
          </button>

          <button
            onClick={togglePlay}
            className="interactive"
            style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              background: 'var(--accent-gradient)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              border: 'none',
              boxShadow: 'var(--shadow-glow)'
            }}
          >
            {isPlaying ? <Pause size={32} /> : <Play size={32} style={{ marginLeft: '4px' }} />}
          </button>

          <button
            onClick={() => seekBy(10)}
            className="interactive glass-pill"
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              border: 'none'
            }}
          >
            <RotateCw size={22} />
          </button>
        </div>

        {/* Bottom Control Bar */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
          {/* Netflix-style toolbar: episode / subtitles / quality selection,
              anchored right above the seek bar instead of the top header.
              Wrapped in its own relative container so the dropdown panels
              (bottom: 100%) clear this row exactly, regardless of how tall
              the progress bar/timestamps below it are. */}
          <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
            {episodeList && episodeList.length > 0 && onSelectEpisode && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowEpisodeMenu(prev => !prev);
                  setShowSubtitleMenu(false);
                  setShowQualityMenu(false);
                }}
                className="interactive glass-pill"
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-full)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  border: 'none',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: 600
                }}
              >
                <ListVideo size={16} />
                <span>Episodes</span>
              </button>
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowSubtitleMenu(prev => !prev);
                setShowQualityMenu(false);
                setShowEpisodeMenu(false);
              }}
              className="interactive glass-pill"
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                border: 'none',
                color: activeSubtitle ? '#ffffff' : '#94a3b8',
                fontSize: '12px',
                fontWeight: 600
              }}
            >
              <Subtitles size={16} />
              <span>CC</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowQualityMenu(prev => !prev);
                setShowSubtitleMenu(false);
                setShowEpisodeMenu(false);
              }}
              className="interactive glass-pill"
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                border: 'none',
                color: '#fff',
                fontSize: '12px',
                fontWeight: 600
              }}
            >
              <Settings size={15} />
              <span>{selectedQuality}</span>
            </button>
          </div>

          {/* Episode Menu - scrollable, opens upward above the toolbar.
              Stops touch events here from reaching the container's volume-
              swipe gesture handler, which would otherwise fight a finger
              scrolling this list. */}
          {showEpisodeMenu && episodeList && onSelectEpisode && (
            <div
              className="glass-panel-dark"
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                right: 0,
                left: 0,
                maxHeight: '260px',
                overflowY: 'auto',
                borderRadius: 'var(--radius-md)',
                padding: '8px',
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '6px',
                zIndex: 50,
                boxShadow: 'var(--shadow-lg)'
              }}
            >
              {episodeList.map((ep) => {
                const isCurrent = ep.id === episode.id;
                return (
                  <button
                    key={ep.id}
                    onClick={() => {
                      setShowEpisodeMenu(false);
                      if (!isCurrent) onSelectEpisode(ep);
                    }}
                    className="interactive"
                    style={{
                      padding: '10px 4px',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: isCurrent ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                      color: isCurrent ? '#ffffff' : '#cbd5e1',
                      fontSize: '13px',
                      fontWeight: isCurrent ? 700 : 500,
                      border: 'none',
                      textAlign: 'center'
                    }}
                  >
                    {ep.number}
                  </button>
                );
              })}
            </div>
          )}

          {/* Quality Menu Overlay - opens upward above the toolbar */}
          {showQualityMenu && (
            <div
              className="glass-panel-dark"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                right: 0,
                borderRadius: 'var(--radius-md)',
                padding: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                zIndex: 50,
                minWidth: '130px',
                boxShadow: 'var(--shadow-lg)'
              }}
            >
              {(streamSource.qualities && streamSource.qualities.length > 0
                ? streamSource.qualities
                : [{ quality: '1080p', url: streamSource.streamUrl }]
              ).map((item) => (
                <button
                  key={item.quality}
                  onClick={() => switchQuality(item)}
                  className="interactive"
                  style={{
                    padding: '8px 14px',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    backgroundColor: selectedQuality === item.quality ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                    color: selectedQuality === item.quality ? '#ffffff' : '#cbd5e1',
                    fontSize: '13px',
                    fontWeight: selectedQuality === item.quality ? 700 : 500,
                    border: 'none',
                    textAlign: 'left'
                  }}
                >
                  <span>{item.quality}</span>
                  {selectedQuality === item.quality && <Check size={14} />}
                </button>
              ))}
            </div>
          )}

          {/* Subtitle Menu Overlay - opens upward above the toolbar */}
          {showSubtitleMenu && (
            <div
              className="glass-panel-dark"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                right: '84px',
                borderRadius: 'var(--radius-md)',
                padding: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                zIndex: 50,
                minWidth: '140px',
                boxShadow: 'var(--shadow-lg)'
              }}
            >
              <button
                onClick={() => {
                  setActiveSubtitle(null);
                  setShowSubtitleMenu(false);
                }}
                className="interactive"
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  backgroundColor: activeSubtitle === null ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                  color: activeSubtitle === null ? '#ffffff' : '#cbd5e1',
                  fontSize: '13px',
                  fontWeight: activeSubtitle === null ? 700 : 500,
                  border: 'none',
                  textAlign: 'left'
                }}
              >
                <span>Off</span>
                {activeSubtitle === null && <Check size={14} />}
              </button>
              {streamSource.subtitles.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setActiveSubtitle(s.label);
                    setShowSubtitleMenu(false);
                  }}
                  className="interactive"
                  style={{
                    padding: '8px 14px',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    backgroundColor: activeSubtitle === s.label ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                    color: activeSubtitle === s.label ? '#ffffff' : '#cbd5e1',
                    fontSize: '13px',
                    fontWeight: activeSubtitle === s.label ? 700 : 500,
                    border: 'none',
                    textAlign: 'left'
                  }}
                >
                  <span>{s.label}</span>
                  {activeSubtitle === s.label && <Check size={14} />}
                </button>
              ))}
            </div>
          )}
          </div>

          {/* Progress Bar & Buffered Track */}
          <div style={{ position: 'relative', width: '100%', height: '20px', display: 'flex', alignItems: 'center' }}>
            {/* Background track */}
            <div style={{ position: 'absolute', width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '2px' }} />
            {/* Buffer track */}
            <div style={{
              position: 'absolute',
              width: `${(buffered / (duration || 1)) * 100}%`,
              height: '4px',
              backgroundColor: 'rgba(255,255,255,0.4)',
              borderRadius: '2px'
            }} />
            {/* Played track */}
            <div style={{
              position: 'absolute',
              width: `${(currentTime / (duration || 1)) * 100}%`,
              height: '4px',
              background: 'var(--accent-gradient)',
              borderRadius: '2px'
            }} />
            {/* Range input for scrubbing */}
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={currentTime}
              onChange={handleSeek}
              style={{
                position: 'relative',
                width: '100%',
                opacity: 0,
                cursor: 'pointer',
                height: '24px',
                zIndex: 10
              }}
            />
          </div>

          {/* Timestamps and Auxiliary Controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>
              <span>{formatTime(currentTime)}</span>
              <span style={{ color: '#64748b' }}>/</span>
              <span style={{ color: '#94a3b8' }}>{formatTime(duration)}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              {/* Mute Toggle */}
              <button
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.muted = !isMuted;
                    setIsMuted(!isMuted);
                  }
                }}
                className="interactive"
                style={{ background: 'none', border: 'none', color: '#cbd5e1' }}
              >
                {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>

              {/* Next Episode Button */}
              {hasNextEpisode && onNextEpisode && (
                <button
                  onClick={onNextEpisode}
                  className="interactive glass-pill"
                  style={{
                    padding: '5px 12px',
                    borderRadius: 'var(--radius-full)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    border: 'none',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 600
                  }}
                >
                  <SkipForward size={14} />
                  <span>Next</span>
                </button>
              )}

              {/* Fullscreen Toggle */}
              <button
                onClick={toggleFullscreen}
                className="interactive"
                style={{ background: 'none', border: 'none', color: '#cbd5e1' }}
              >
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
