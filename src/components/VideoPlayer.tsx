// VideoPlayer.tsx - Premium Mobile Video Player with HLS, Gestures, & Ani-cli controls
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
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

// VOD episodes, not a live broadcast - lowLatencyMode trims buffers to chase
// the live edge, which only makes stalls more likely here. A bigger forward
// buffer instead gives real cushion against network hiccups, while the back
// buffer is capped so a long binge doesn't keep hundreds of MB of already-
// watched segments in memory.
function createHls(referer: string): Hls {
  return new Hls({
    enableWorker: false,
    backBufferLength: 30,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    maxBufferSize: 120 * 1000 * 1000,
    // Loader-level retries for manifests/segments before a fatal error is
    // even raised - covers the common single dropped request.
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10000,
        maxLoadTimeMs: 60000,
        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
      }
    },
    xhrSetup: (xhr) => {
      // CapacitorHttp intercepts this and allows setting custom headers like Referer
      xhr.setRequestHeader('Referer', referer);
    }
  });
}

// Fatal hls.js network errors are retried this many times with exponential
// backoff (1s, 2s, 4s) before the stream is declared dead.
const MAX_NETWORK_RETRIES = 3;
// How often playback position is persisted while playing (it's also saved
// on pause, on episode change and when the player closes).
const PROGRESS_SAVE_INTERVAL_MS = 5000;

interface VideoPlayerProps {
  streamSource: StreamSource;
  animeTitle: string;
  episode: EpisodeItem;
  mode: 'sub' | 'dub';
  onBack: () => void;
  onNextEpisode?: () => void;
  hasNextEpisode?: boolean;
  // Reported every few seconds while playing, on pause, and one final time
  // when the stream changes or the player closes. `streamUrl` is the URL
  // the <video> was actually playing, so the caller can drop reports that
  // belong to a stream it has already moved on from.
  onProgressUpdate?: (currentTime: number, duration: number, streamUrl: string) => void;
  initialTime?: number;
  episodeList?: EpisodeItem[];
  onSelectEpisode?: (ep: EpisodeItem) => void;
  // Re-resolves the same episode in the other audio language (sub <-> dub).
  onSwitchMode?: (mode: 'sub' | 'dub') => void;
  // The stream failed for good (after retries). The parent tries another
  // server and, if it finds one, swaps in a new streamSource (resolves
  // true); false means none was left and the error dialog is shown.
  onStreamFailed?: (positionSec: number) => Promise<boolean>;
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
  onSwitchMode,
  onStreamFailed
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
  // Which stream `duration` currently belongs to - see the AniSkip effect.
  const durationUrlRef = useRef<string | null>(null);
  // Bumped by the error dialog's Retry button to rebuild the stream.
  const [reloadToken, setReloadToken] = useState<number>(0);
  const resumeAtRef = useRef<number | null>(null);
  // Last known position/duration and the URL they belong to, for progress
  // reports and for resuming after a retry.
  const lastPositionRef = useRef<number>(0);
  const lastDurationRef = useRef<number>(0);
  const loadedUrlRef = useRef<string>('');
  const lastProgressSaveRef = useRef<number>(0);
  const onStreamFailedRef = useRef(onStreamFailed);
  const onProgressUpdateRef = useRef(onProgressUpdate);
  // Layout effect so the ref is current before the stream effect below
  // captures it for a new stream.
  useLayoutEffect(() => {
    onProgressUpdateRef.current = onProgressUpdate;
    onStreamFailedRef.current = onStreamFailed;
  }, [onProgressUpdate, onStreamFailed]);

  // Every short-lived UI timeout goes through here so none can fire (and
  // set state) after the player has closed.
  const pendingTimeouts = useRef<Set<number>>(new Set());
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      pendingTimeouts.current.delete(id);
      fn();
    }, ms);
    pendingTimeouts.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    const timeouts = pendingTimeouts.current;
    return () => {
      timeouts.forEach(id => window.clearTimeout(id));
      timeouts.clear();
      if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      if (volumeIndicatorTimerRef.current) window.clearTimeout(volumeIndicatorTimerRef.current);
    };
  }, []);

  // The fullscreen state must follow the browser: the system back gesture
  // or Esc leaves fullscreen without going through our toggle.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const reportProgress = useCallback((force: boolean) => {
    const url = loadedUrlRef.current;
    const duration = lastDurationRef.current;
    if (!url || !(duration > 0)) return;
    const now = Date.now();
    if (!force && now - lastProgressSaveRef.current < PROGRESS_SAVE_INTERVAL_MS) return;
    lastProgressSaveRef.current = now;
    onProgressUpdateRef.current?.(lastPositionRef.current, duration, url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getUserPreferences().then(p => {
      if (cancelled) return;
      setAutoSkipIntro(p.autoSkipIntro);
      setAutoPlayNext(p.autoPlayNext);
    });
    return () => { cancelled = true; };
  }, []);

  // A new episode/stream means a fresh intro/outro to (maybe) look up and auto-skip.
  useEffect(() => {
    autoSkippedRef.current = false;
    introLookupRef.current = null;
    // The previous episode's duration/position must not leak into this one
    // (it used to be sent to AniSkip as this episode's length).
    durationUrlRef.current = null;
    setDuration(0);
    setCurrentTime(0);
    setBuffered(0);
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
    // `duration` can still be the previous episode's for one render after a
    // stream change - only trust it once durationchange reported it for
    // this stream.
    const url = streamSource.streamUrl;
    if (durationUrlRef.current !== url) return;
    if (introLookupRef.current === url) return;
    introLookupRef.current = url;
    if (streamSource.intro && streamSource.outro) return;

    getEpisodeSkipIntervals(animeTitle, episode.number, duration).then(({ opening, ending }) => {
      // Moved on to another episode while this was in flight.
      if (introLookupRef.current !== url) return;
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

    const streamUrl = resolvePlayableUrl(streamSource.streamUrl, streamSource.referer);
    const referer = streamSource.referer || 'https://zokoanime.video/';
    // A Retry resumes where playback stopped rather than at initialTime.
    const startAt = resumeAtRef.current ?? initialTime;
    resumeAtRef.current = null;
    let disposed = false;
    let retryTimer: number | null = null;

    loadedUrlRef.current = streamUrl;
    lastPositionRef.current = startAt;
    lastDurationRef.current = 0;
    lastProgressSaveRef.current = Date.now();
    // Captured now so the final report in the cleanup goes to the handler
    // that belongs to this stream, even after the parent re-rendered with
    // the next episode.
    const reportFinal = onProgressUpdateRef.current;

    setVideoTrackWarning(null);
    setStreamError(null);
    setIsBuffering(true);

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

    const startPlayback = () => {
      if (disposed) return;
      if (startAt > 0) video.currentTime = startAt;
      video.play()
        .then(() => { if (!disposed) setIsPlaying(true); })
        .catch(() => { if (!disposed) setIsPlaying(false); });
    };

    const showFailure = (message: string) => {
      if (disposed) return;
      setIsPlaying(false);
      setIsBuffering(false);
      setStreamError(message);
    };

    // A dead stream (e.g. the CDN 404s a segment) first falls back to
    // another server for the same episode, resuming at this position; the
    // error dialog only appears when no other server is left.
    const failStream = (message: string) => {
      if (disposed) return;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      const fallback = onStreamFailedRef.current;
      if (!fallback) {
        showFailure(message);
        return;
      }
      setIsBuffering(true);
      fallback(lastPositionRef.current)
        .then(found => { if (!found) showFailure(message); })
        .catch(() => showFailure(message));
    };
    failStreamRef.current = failStream;

    const isMp4 = streamUrl.toLowerCase().split('?')[0].endsWith('.mp4');
    const nativeHls = !Hls.isSupported() && !!video.canPlayType('application/vnd.apple.mpegurl');

    if (isMp4 || nativeHls) {
      // Direct file, or native HLS (Safari/iOS WebView). The listener is
      // removed in the cleanup - it used to stay attached, so after an
      // episode switch the old one seeked the new episode to the old
      // resume point.
      video.addEventListener('loadedmetadata', startPlayback, { once: true });
      video.src = streamUrl;
      video.load();
    } else if (Hls.isSupported()) {
      const hls = createHls(referer);
      hlsRef.current = hls;
      let networkRetries = 0;
      let mediaRecoveries = 0;

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[VideoPlayer] Manifest parsed, levels count:', data.levels.length);
        if (data.levels.length > 0 && data.levels.every(l => !l.videoCodec && !l.width)) {
          setVideoTrackWarning('No video track in this stream (audio only or unsupported codec).');
        }
        startPlayback();
      });

      // Healthy again - a later hiccup gets the full retry budget.
      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
        mediaRecoveries = 0;
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[VideoPlayer] hls.js error:', data.type, data.details, 'fatal:', data.fatal);
        if (!data.fatal || disposed) return;
        const status = data.response?.code;
        // A 4xx (except 429) is the CDN saying the file isn't there - no
        // retry will change that, so go straight to the server fallback.
        const definitive = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
        const manifestFailed = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
          || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
          || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && definitive) {
          failStream(`This stream failed to load (HTTP ${status}).`);
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.details !== Hls.ErrorDetails.MANIFEST_PARSING_ERROR
          && networkRetries < MAX_NETWORK_RETRIES) {
          const delay = 1000 * 2 ** networkRetries;
          networkRetries++;
          setIsBuffering(true);
          retryTimer = window.setTimeout(() => {
            if (disposed) return;
            // startLoad() only resumes segment loading - a playlist that
            // never loaded has to be requested again, or the player just
            // spins forever.
            if (manifestFailed) hls.loadSource(streamUrl);
            else hls.startLoad(Math.max(0, video.currentTime));
          }, delay);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          // Decoder/buffer hiccup: first try a plain MSE recovery, then the
          // audio-codec swap hls.js documents for mismatched AAC signalling.
          mediaRecoveries++;
          if (mediaRecoveries === 2) hls.swapAudioCodec();
          hls.recoverMediaError();
        } else {
          console.warn('[VideoPlayer] HLS stream unrecoverable');
          failStream('This stream failed to load.');
        }
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);
    } else {
      failStream("This device can't play this stream format.");
    }

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      video.removeEventListener('timeupdate', checkVideoTrack);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handleResumed);
      video.removeEventListener('canplay', handleResumed);
      video.removeEventListener('loadedmetadata', startPlayback);
      // Final position of this stream, before anything is torn down.
      if (lastDurationRef.current > 0) {
        reportFinal?.(lastPositionRef.current, lastDurationRef.current, streamUrl);
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      // Detach the source so the element really stops downloading/decoding
      // (a bare unmount can keep the connection alive until GC).
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [streamSource.streamUrl, streamSource.referer, initialTime, reloadToken]);

  // The element-level error handler (direct MP4 / native HLS) goes through
  // the same fallback path as hls.js failures.
  const failStreamRef = useRef<((message: string) => void) | null>(null);

  const retryStream = () => {
    resumeAtRef.current = lastPositionRef.current;
    setStreamError(null);
    setReloadToken(t => t + 1);
  };

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

  // Controls fade out on their own once playback actually starts (not only
  // after the first tap), and come back and stay while paused.
  useEffect(() => {
    if (isPlaying) {
      resetControlsTimer();
    } else if (hideControlsTimer.current) {
      window.clearTimeout(hideControlsTimer.current);
    }
  }, [isPlaying, resetControlsTimer]);

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
      // play() rejects when interrupted or blocked by autoplay policy -
      // onPlay/onPause keep isPlaying in sync with what really happened.
      video.play().catch(() => setIsPlaying(false));
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
      const hls = createHls(streamSource.referer);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setIsPlaying(false);
          setStreamError('This quality failed to load.');
        }
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
        later(() => setDoubleTapFeedback(null), 600);
      } else if (x > width * 0.6) {
        seekBy(10);
        setDoubleTapFeedback('right');
        later(() => setDoubleTapFeedback(null), 600);
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
      later(() => setSkippedIntroToast(false), 1800);
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

    lastPositionRef.current = video.currentTime;
    if (total > 0) lastDurationRef.current = total;
    // Throttled: timeupdate fires ~4x a second, and every save is a full
    // read-modify-write of the history list in storage.
    reportProgress(false);
  };

  // HLS/MSE streams can report NaN duration when 'loadedmetadata' first fires
  // (it only fires once); the real duration arrives later via 'durationchange'.
  const handleDurationChange = () => {
    if (videoRef.current && isFinite(videoRef.current.duration)) {
      durationUrlRef.current = streamSource.streamUrl;
      lastDurationRef.current = videoRef.current.duration;
      setDuration(videoRef.current.duration);
    }
  };

  const handleVideoError = () => {
    // With hls.js attached, element errors are MSE hiccups that its own
    // ERROR handler recovers from (or reports) - don't pre-empt it.
    if (hlsRef.current) return;
    // The cleanup detaching the source (removeAttribute + load) is not a
    // playback failure.
    if (!videoRef.current?.getAttribute('src')) return;
    console.warn('[VideoPlayer] Native video playback error');
    if (failStreamRef.current) {
      failStreamRef.current('This stream failed to load.');
    } else {
      setIsPlaying(false);
      setStreamError('This stream failed to load.');
    }
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

    // isFullscreen itself follows the fullscreenchange event.
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fullscreen API unavailable/denied (some mobile WebViews) - ignore.
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
  // Paused always shows the controls (Netflix behaviour); while playing they
  // follow the auto-hide timer / taps.
  const controlsVisible = (showControls || !isPlaying) && !isLocked && !anyPanelOpen;

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
        onPause={() => {
          setIsPlaying(false);
          reportProgress(true);
        }}
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
          <span style={{ fontSize: '12px', color: '#b3b3b3' }}>The server may be blocking it or the format isn't supported. Try again, or pick another episode.</span>
          <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
            <button onClick={retryStream} className="interactive nf-btn-white" style={{ whiteSpace: 'nowrap' }}>
              Retry
            </button>
            <button onClick={onBack} className="interactive nf-btn-white" style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', whiteSpace: 'nowrap' }}>
              Go Back
            </button>
          </div>
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
