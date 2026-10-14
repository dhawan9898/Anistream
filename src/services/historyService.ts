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
const EPISODE_LOG_KEY = 'anistream_episode_log';
const EPISODE_LOG_MAX = 300;

// How far into one episode the viewer got. Kept for every episode watched
// (not just the latest per title) so the episode list can show what has been
// seen and what is half-finished.
export interface EpisodeProgress {
  currentTime: number;
  duration: number;
}

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

// Screens that show history/bookmarks (Home's Continue Watching, the title
// page's Resume button, the Library) stay mounted underneath the player, so
// they subscribe here instead of only reading storage once on mount - which
// left "Resume E3" showing after the user had already watched E4.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeLibraryChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// While an episode plays, progress is saved every few seconds. Screens
// underneath the player must not re-render for each of those saves, so the
// notification is held back and delivered once playback is over.
let playbackActive = false;
let notifyPending = false;

export function setPlaybackActive(active: boolean): void {
  playbackActive = active;
  if (!active && notifyPending) {
    notifyPending = false;
    notifyLibraryChanged();
  }
}

function notifyLibraryChanged(force = true): void {
  if (playbackActive && !force) {
    notifyPending = true;
    return;
  }
  listeners.forEach(listener => {
    try {
      listener();
    } catch (err) {
      console.error('Library change listener failed:', err);
    }
  });
}

function parseList<T>(value: string | null, isValid: (item: any) => boolean): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    // Entries that don't have the expected shape are dropped one by one
    // rather than crashing whichever screen renders them.
    return Array.isArray(parsed) ? parsed.filter(isValid) : [];
  } catch {
    // Corrupt entry (e.g. an interrupted write) - start over rather than
    // throwing on every read and bricking the Library screen.
    return [];
  }
}

// Real episode ids are numeric. Older builds saved "<slug>-ep-N" ids for
// made-up placeholder episodes (they only ever played a demo clip), which
// can't be resumed - those entries are dropped.
const isHistoryItem = (h: any): boolean =>
  !!h && typeof h.animeId === 'string' && typeof h.episodeId === 'string' &&
  /^\d+$/.test(h.episodeId) && typeof h.currentTime === 'number' && isFinite(h.currentTime);

const isAnimeItem = (a: any): boolean => !!a && typeof a.id === 'string' && typeof a.title === 'string';

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
      await recordEpisode(latest);
      notifyLibraryChanged(false);
    } catch (err) {
      console.error("Failed to save watch history:", err);
    }
  });
}

// Every episode ever watched, one entry per title + episode, newest first.
// (HISTORY_KEY keeps only the latest episode per title for Continue Watching.)
async function readEpisodeLog(): Promise<WatchHistoryItem[]> {
  try {
    const { value } = await Preferences.get({ key: EPISODE_LOG_KEY });
    return parseList<WatchHistoryItem>(value, isHistoryItem);
  } catch {
    return [];
  }
}

const logKey = (h: Pick<WatchHistoryItem, 'animeId' | 'episodeId'>) => `${h.animeId}|${h.episodeId}`;

async function recordEpisode(item: WatchHistoryItem): Promise<void> {
  const log = (await readEpisodeLog()).filter(h => logKey(h) !== logKey(item));
  log.unshift(item);
  await Preferences.set({ key: EPISODE_LOG_KEY, value: JSON.stringify(log.slice(0, EPISODE_LOG_MAX)) });
}

// All watched episodes for the Library. Entries from before the log existed
// (latest episode per title) are included so nothing disappears on update.
export async function getEpisodeLog(): Promise<WatchHistoryItem[]> {
  const [log, latest] = await Promise.all([readEpisodeLog(), getWatchHistory()]);
  const seen = new Set(log.map(logKey));
  const merged = [...log, ...latest.filter(h => !seen.has(logKey(h)))];
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Per-episode progress for one title, keyed by episode id.
export async function getEpisodeProgress(animeId: string): Promise<Record<string, EpisodeProgress>> {
  const result: Record<string, EpisodeProgress> = {};
  for (const h of await getEpisodeLog()) {
    if (h.animeId === animeId && h.duration > 0) {
      result[h.episodeId] = { currentTime: h.currentTime, duration: h.duration };
    }
  }
  return result;
}

export async function getWatchHistory(): Promise<WatchHistoryItem[]> {
  try {
    const { value } = await Preferences.get({ key: HISTORY_KEY });
    return parseList<WatchHistoryItem>(value, isHistoryItem);
  } catch (err) {
    console.error("Failed to load history:", err);
  }
  return [];
}

export function clearWatchHistory(): Promise<void> {
  pendingProgress = null;
  return serialized(async () => {
    await Preferences.remove({ key: HISTORY_KEY });
    await Preferences.remove({ key: EPISODE_LOG_KEY });
    await Preferences.remove({ key: 'anistream_episode_progress' });
    notifyLibraryChanged();
  });
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
    const log = (await readEpisodeLog()).filter(h => h.animeId !== animeId);
    await Preferences.set({ key: EPISODE_LOG_KEY, value: JSON.stringify(log) });
    notifyLibraryChanged();
    return filtered;
  });
}

// Removes one watched episode from the Library list. If it was the title's
// "latest" (Continue Watching) entry, the next most recent episode of that
// title takes its place, or the title leaves Continue Watching.
export function removeEpisodeFromLibrary(animeId: string, episodeId: string): Promise<WatchHistoryItem[]> {
  return serialized(async () => {
    const all = await getEpisodeLog();
    const remaining = all.filter(h => !(h.animeId === animeId && h.episodeId === episodeId));
    await Preferences.set({ key: EPISODE_LOG_KEY, value: JSON.stringify(remaining.slice(0, EPISODE_LOG_MAX)) });
    const latest = (await getWatchHistory()).filter(h => h.animeId !== animeId);
    const replacement = remaining.find(h => h.animeId === animeId);
    const history = replacement ? [replacement, ...latest] : latest;
    history.sort((a, b) => b.updatedAt - a.updatedAt);
    await Preferences.set({ key: HISTORY_KEY, value: JSON.stringify(history) });
    notifyLibraryChanged();
    return remaining;
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
    notifyLibraryChanged();
    return !exists;
  });
}

export async function getBookmarks(): Promise<AnimeItem[]> {
  try {
    const { value } = await Preferences.get({ key: BOOKMARKS_KEY });
    return parseList<AnimeItem>(value, isAnimeItem);
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

// Also a read-modify-write: two quick toggles in Settings must not race
// and drop one of the changes.
export function saveUserPreferences(prefs: Partial<UserPreferences>): Promise<void> {
  return serialized(async () => {
    const current = await getUserPreferences();
    const updated = { ...current, ...prefs };
    await Preferences.set({
      key: PREFERENCES_KEY,
      value: JSON.stringify(updated)
    });
  });
}

// True when an entry is effectively finished (credits or less remaining),
// so "resume" should start the episode over / move on instead of dropping
// the viewer into the end credits.
// 'finished' / 'partial' / 'unwatched' for the episode list badges.
export function episodeWatchState(p: EpisodeProgress | undefined): 'finished' | 'partial' | 'unwatched' {
  if (!p) return 'unwatched';
  if (isEpisodeFinished(p)) return 'finished';
  return p.currentTime >= 15 ? 'partial' : 'unwatched';
}

export function isEpisodeFinished(item: Pick<WatchHistoryItem, 'currentTime' | 'duration'>): boolean {
  return item.duration > 0 && (item.duration - item.currentTime <= 30 || item.currentTime / item.duration >= 0.95);
}
