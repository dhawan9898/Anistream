// persistentCache.ts - AniStream's disk cache for site pages and episode
// lists, stored in IndexedDB (see offlineStore). Used under the in-memory
// cache in aniCliCore:
//
//  - a page fetched less than its TTL ago is served instantly on a cold start,
//    without waiting on the network;
//  - when the network fails (offline, site down), the last copy that was
//    saved - however old, within MAX_STALE_MS - is served instead of an error,
//    which is what lets titles that were viewed before open without internet.
import { createPersistentCache } from 'streamkit/core/persistentCache.ts';
import { cachePrune, cacheRead, cacheWrite } from './offlineStore.ts';

// How long a saved copy may stand in for an unreachable site.
export const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

// The previous (localStorage) cache is only read as a fallback for copies
// saved before the move to IndexedDB, and is then left to expire.
const legacy = createPersistentCache({
  prefix: 'anistream:pc2:',
  legacyPrefix: 'anistream:pc:',
  maxChars: 2_000_000,
  defaultTtlMs: 3 * 24 * 60 * 60 * 1000
});

legacy.prune();
void cachePrune(MAX_STALE_MS, MAX_ENTRIES);

/** The saved copy of `key` with its age, however old (callers decide how stale is too stale). */
export async function readPersisted(key: string): Promise<{ value: string; savedAt: number } | null> {
  const row = await cacheRead<string>(`pc:${key}`);
  if (row) return row;
  const old = legacy.getEntry<string>(key);
  return old ? { value: old.data, savedAt: old.savedAt } : null;
}

export function writePersisted(key: string, value: string): void {
  void cacheWrite(`pc:${key}`, value);
}

/** Any JSON-serialisable value (title details, resolved titles). */
export async function readPersistedJson<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  return cacheRead<T>(`json:${key}`);
}

export function writePersistedJson<T>(key: string, value: T): void {
  void cacheWrite(`json:${key}`, value);
}

/** True when the device reports no connection (the fetch would only time out). */
export const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;
