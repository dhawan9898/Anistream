// playerUtils.ts - Pure helpers and constants for the web video player.
import Hls from 'hls.js';
import { Capacitor } from '@capacitor/core';
import type { PlayerSubtitleTrack } from './types.ts';

// `fallbackReferer` is used by the dev proxy when a stream carries no referer of its own.
export const resolvePlayableUrl = (url?: string, referer?: string, fallbackReferer = ''): string => {
  if (!url) return '';
  // In dev / web mode without native CapacitorHttp, proxy the stream to bypass browser CORS & Referer restrictions
  if (!Capacitor.isNativePlatform() && !url.startsWith('/stream-proxy') && url.startsWith('http')) {
    const ref = referer || fallbackReferer;
    return `/stream-proxy?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(ref)}`;
  }
  return url;
};

// VOD episodes, not a live broadcast - lowLatencyMode trims buffers to chase
// the live edge, which only makes stalls more likely here. A bigger forward
// buffer instead gives real cushion against network hiccups, while the back
// buffer is capped so a long binge doesn't keep hundreds of MB of already-
// watched segments in memory.
export function createHls(referer: string): Hls {
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

// Subtitles start on for sub and off for dub: a dub server's caption files
// are usually the subbed release's, timed to the Japanese dialogue, so they
// never line up with the English audio (they can still be turned on).
export function defaultSubtitleLabel(subtitles: PlayerSubtitleTrack[], mode: 'sub' | 'dub'): string | null {
  if (mode === 'dub') return null;
  return subtitles.find(s => s.default)?.label ?? subtitles[0]?.label ?? null;
}


export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
// Netflix-style post-play: the "Next Episode" button fills up over this many
// seconds of playback, then advances (when autoplay is on).
export const NEXT_EPISODE_COUNTDOWN_SECS = 10;
// Without an outro marker, post-play appears this close to the end.
export const POST_PLAY_THRESHOLD_SECS = 20;
export const NETFLIX_RED = '#e50914';


export function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const mm = h > 0 ? m.toString().padStart(2, '0') : m.toString();
  return `${h > 0 ? `${h}:` : ''}${mm}:${s.toString().padStart(2, '0')}`;
}
