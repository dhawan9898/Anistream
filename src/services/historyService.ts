// historyService.ts - Watch history, bookmarks, and preferences management
import { Preferences } from '@capacitor/preferences';

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

export async function saveWatchProgress(item: WatchHistoryItem): Promise<void> {
  try {
    const list = await getWatchHistory();
    const filtered = list.filter(h => h.animeId !== item.animeId);
    filtered.unshift(item); // Put most recent first
    const trimmed = filtered.slice(0, 30); // Keep last 30
    await Preferences.set({
      key: HISTORY_KEY,
      value: JSON.stringify(trimmed)
    });
  } catch (err) {
    console.error("Failed to save watch history:", err);
  }
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

export async function clearWatchHistory(): Promise<void> {
  await Preferences.remove({ key: HISTORY_KEY });
}

export async function toggleBookmark(animeId: string): Promise<boolean> {
  const bookmarks = await getBookmarks();
  const exists = bookmarks.includes(animeId);
  const updated = exists ? bookmarks.filter(id => id !== animeId) : [...bookmarks, animeId];
  await Preferences.set({
    key: BOOKMARKS_KEY,
    value: JSON.stringify(updated)
  });
  return !exists;
}

export async function getBookmarks(): Promise<string[]> {
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
