// VideoPlayer.tsx - Premium Mobile Video Player with HLS, Gestures, & Ani-cli controls
import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play, Pause, RotateCcw, RotateCw, ArrowLeft, Settings, 
  Subtitles, Maximize, Minimize, SkipForward, FastForward, Volume2, VolumeX 
} from 'lucide-react';
import type { StreamSource, EpisodeItem } from '../core/aniCliCore';

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
  initialTime = 0
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [buffered, setBuffered] = useState<number>(0);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [selectedQuality, setSelectedQuality] = useState<string>(streamSource.quality || '1080p');
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState<boolean>(false);
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>('English');
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [showSkipIntro, setShowSkipIntro] = useState<boolean>(false);
  const [doubleTapFeedback, setDoubleTapFeedback] = useState<'left' | 'right' | null>(null);
  const [videoTrackWarning, setVideoTrackWarning] = useState<string | null>(null);

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

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        lowLatencyMode: true,
        backBufferLength: 90
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

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[VideoPlayer] hls.js error:', data.type, data.details, 'fatal:', data.fatal);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
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

  // Double tap to seek (left side: -10s, right side: +10s)
  const handleTap = (e: React.MouseEvent<HTMLDivElement>) => {
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

  // Time & progress tracker
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);

    // Show skip intro button between 0s and 120s
    if (video.currentTime >= 5 && video.currentTime <= 120) {
      setShowSkipIntro(true);
    } else {
      setShowSkipIntro(false);
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
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          if (hasNextEpisode && onNextEpisode) {
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

      {/* Skip Intro Floating Pill */}
      {showSkipIntro && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            seekBy(85);
            setShowSkipIntro(false);
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
            border: '1px solid rgba(99, 102, 241, 0.5)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.7)',
            zIndex: 10
          }}
        >
          <FastForward size={16} color="#6366f1" />
          <span>Skip Intro (+85s)</span>
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
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Subtitles Button */}
            <button
              onClick={() => setShowSubtitleMenu(prev => !prev)}
              className="interactive glass-pill"
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                border: 'none',
                color: activeSubtitle ? '#6366f1' : '#94a3b8',
                fontSize: '12px',
                fontWeight: 600
              }}
            >
              <Subtitles size={16} />
              <span>CC</span>
            </button>

            {/* Quality Button */}
            <button
              onClick={() => setShowQualityMenu(prev => !prev)}
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
        </div>

        {/* Quality Menu Overlay */}
        {showQualityMenu && (
          <div 
            className="glass-panel"
            style={{
              position: 'absolute',
              top: '70px',
              right: '20px',
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
                onClick={() => {
                  setSelectedQuality(item.quality);
                  setShowQualityMenu(false);
                  if (videoRef.current && item.url) {
                    const prevTime = videoRef.current.currentTime;
                    if (hlsRef.current) {
                      hlsRef.current.loadSource(resolvePlayableUrl(item.url, streamSource.referer));
                      hlsRef.current.once(Hls.Events.MANIFEST_PARSED, () => {
                        if (videoRef.current) {
                          videoRef.current.currentTime = prevTime;
                          videoRef.current.play();
                        }
                      });
                    }
                  }
                }}
                className="interactive"
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: selectedQuality === item.quality ? 'rgba(99, 102, 241, 0.25)' : 'transparent',
                  color: selectedQuality === item.quality ? '#818cf8' : '#cbd5e1',
                  fontSize: '13px',
                  fontWeight: selectedQuality === item.quality ? 700 : 500,
                  border: 'none',
                  textAlign: 'left'
                }}
              >
                {item.quality}
              </button>
            ))}
          </div>
        )}

        {/* Subtitle Menu Overlay */}
        {showSubtitleMenu && (
          <div 
            className="glass-panel"
            style={{
              position: 'absolute',
              top: '70px',
              right: '90px',
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
                backgroundColor: activeSubtitle === null ? 'rgba(99, 102, 241, 0.25)' : 'transparent',
                color: activeSubtitle === null ? '#818cf8' : '#cbd5e1',
                fontSize: '13px',
                fontWeight: activeSubtitle === null ? 700 : 500,
                border: 'none',
                textAlign: 'left'
              }}
            >
              Off
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
                  backgroundColor: activeSubtitle === s.label ? 'rgba(99, 102, 241, 0.25)' : 'transparent',
                  color: activeSubtitle === s.label ? '#818cf8' : '#cbd5e1',
                  fontSize: '13px',
                  fontWeight: activeSubtitle === s.label ? 700 : 500,
                  border: 'none',
                  textAlign: 'left'
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
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
