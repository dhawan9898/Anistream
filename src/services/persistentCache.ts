// persistentCache.ts - AniStream's disk cache, configured on the shared tiered
// cache in streamkit. Used under the in-memory cache in aniCliCore:
//
//  - a page fetched less than its TTL ago is served instantly on a cold start,
//    without waiting on the network;
//  - when the network fails (offline, site down), the last copy that was
//    saved - however old, within MAX_STALE_MS - is served instead of an error.
import { createPersistentCache } from 'streamkit/core/persistentCache.ts';

export const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;

const cache = createPersistentCache({
  prefix: 'anistream:pc2:',
  // The previous cache format ('anistream:pc:' + an index key) is cleaned up on startup.
  legacyPrefix: 'anistream:pc:',
  maxChars: 2_000_000,
  defaultTtlMs: MAX_STALE_MS
});

cache.prune();

/** The saved copy of `key` with its age, however old (callers decide how stale is too stale). */
export function readPersisted(key: string): { value: string; savedAt: number } | null {
  const entry = cache.getEntry<string>(key);
  return entry ? { value: entry.data, savedAt: entry.savedAt } : null;
}

export function writePersisted(key: string, value: string): void {
  cache.set(key, value, MAX_STALE_MS);
}
