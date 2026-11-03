// playbackSession.ts - Pure helpers for an in-progress playback session.
import type { AnimeItem, EpisodeItem, StreamSource } from '../providers/aniCliCore';
import { saveWatchProgress, type UserPreferences } from './historyService';

export interface PlaybackSession {
  anime: AnimeItem;
  episode: EpisodeItem;
  mode: 'sub' | 'dub';
  source: StreamSource;
  startTime: number;
}

// Persists a position report for a committed session. The demo fallback
// clip is never the real episode, so its "progress" must not overwrite the
// user's real resume point.
export function saveSessionProgress(session: PlaybackSession, currentTime: number, duration: number): void {
  if (session.source.isFallback || !(duration > 0)) return;
  saveWatchProgress({
    animeId: session.anime.id,
    animeTitle: session.anime.title,
    poster: session.anime.poster,
    episodeId: session.episode.id,
    episodeNumber: session.episode.number,
    currentTime,
    duration,
    updatedAt: Date.now(),
    mode: session.mode
  });
}

// Applies the "Default Quality" preference when the stream actually offers
// more than one distinct rendition to choose from.
export function applyPreferredQuality(source: StreamSource, prefs: UserPreferences): StreamSource {
  const preferred = source.qualities?.find(q => q.quality === prefs.defaultQuality);
  if (preferred && preferred.url !== source.streamUrl) {
    return { ...source, streamUrl: preferred.url, quality: preferred.quality };
  }
  return source;
}
