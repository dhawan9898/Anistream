// historyService.ts - Watch history, bookmarks, and preferences management
import { Preferences } from '@capacitor/preferences';
import type { AnimeItem } from '../core/aniCliCore';

export interface WatchHistoryItem {
  animeId: string;
  animeTitle: string;
  poster: string;
  episodeId: string;
  episodeNumber: string;
  currentTime: number;
  duration: number;
  updatedAt: number;
  mode: 'sub' | 'dub';
}

export interface UserPreferences {
  defaultQuality: string;
  defaultMode: 'sub' | 'dub';
  autoSkipIntro: boolean;
  autoPlayNext: boolean;
}

const HISTORY_KEY = 'anistream_watch_history';
const BOOKMARKS_KEY = 'anistream_bookmarks';
const PREFERENCES_KEY = 'anistream_preferences';

export const DEFAULT_PREFERENCES: UserPreferences = {
  defaultQuality: '1080p',
  defaultMode: 'sub',
  autoSkipIntro: true,
  autoPlayNext: true
};

// Read-modify-write updates of the same storage key must not interleave, or
// a slower write can clobber a newer one (progress ticks arrive every second
// while the user may also bookmark or remove items). All mutations run
// through this queue, one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

// Progress ticks are coalesced: while a write is in flight only the newest
// pending tick is kept, instead of queueing one full rewrite per second.
let pendingProgress: WatchHistoryItem | null = null;

export function saveWatchProgress(item: WatchHistoryItem): Promise<void> {
  const alreadyQueued = pendingProgress !== null;
  pendingProgress = item;
  if (alreadyQueued) return writeQueue.then(() => undefined);
  return serialized(async () => {
    const latest = pendingProgress;
    pendingProgress = null;
    if (!latest) return;
    try {
      const list = await getWatchHistory();
      const filtered = list.filter(h => h.animeId !== latest.animeId);
      filtered.unshift(latest); // Put most recent first
      const trimmed = filtered.slice(0, 30); // Keep last 30
      await Preferences.set({
        key: HISTORY_KEY,
        value: JSON.stringify(trimmed)
      });
    } catch (err) {
      console.error("Failed to save watch history:", err);
    }
  });
}

export async function getWatchHistory(): Promise<WatchHistoryItem[]> {
  try {
    const { value } = await Preferences.get({ key: HISTORY_KEY });
    if (value) {
      return JSON.parse(value);
    }
  } catch (err) {
    console.error("Failed to load history:", err);
  }
  return [];
}

export function clearWatchHistory(): Promise<void> {
  pendingProgress = null;
  return serialized(() => Preferences.remove({ key: HISTORY_KEY }));
}

// Removes a single history entry (one per anime - saveWatchProgress already
// de-dupes by animeId) without touching the rest of the list.
export function removeWatchHistoryItem(animeId: string): Promise<WatchHistoryItem[]> {
  return serialized(async () => {
    const list = await getWatchHistory();
    const filtered = list.filter(h => h.animeId !== animeId);
    await Preferences.set({
      key: HISTORY_KEY,
      value: JSON.stringify(filtered)
    });
    return filtered;
  });
}

// Bookmarks store the full AnimeItem, not just its id: the Saved tab needs to
// render posters/titles for anime that may only exist as live search/home
// results, not in the small curated FEATURED_ANIME list.
export function toggleBookmark(anime: AnimeItem): Promise<boolean> {
  return serialized(async () => {
    const bookmarks = await getBookmarks();
    const exists = bookmarks.some(b => b.id === anime.id);
    const updated = exists ? bookmarks.filter(b => b.id !== anime.id) : [...bookmarks, anime];
    await Preferences.set({
      key: BOOKMARKS_KEY,
      value: JSON.stringify(updated)
    });
    return !exists;
  });
}

export async function getBookmarks(): Promise<AnimeItem[]> {
  try {
    const { value } = await Preferences.get({ key: BOOKMARKS_KEY });
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

export async function getUserPreferences(): Promise<UserPreferences> {
  try {
    const { value } = await Preferences.get({ key: PREFERENCES_KEY });
    return value ? { ...DEFAULT_PREFERENCES, ...JSON.parse(value) } : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export async function saveUserPreferences(prefs: Partial<UserPreferences>): Promise<void> {
  const current = await getUserPreferences();
  const updated = { ...current, ...prefs };
  await Preferences.set({
    key: PREFERENCES_KEY,
    value: JSON.stringify(updated)
  });
}
