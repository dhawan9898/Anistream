// persistentCache.ts - A small disk-backed cache (localStorage) that survives
// app restarts, used under the in-memory cache in aniCliCore:
//
//  - a page fetched less than its TTL ago is served instantly on a cold start,
//    without waiting on the network;
//  - when the network fails (offline, site down), the last copy that was
//    saved - however old, within MAX_STALE_MS - is served instead of an error.
//
// Budgeted (MAX_CHARS) with least-recently-written eviction so it can never
// fill the WebView's storage quota; every access is wrapped because storage
// can be unavailable or full.

const PREFIX = 'anistream:pc:';
const INDEX_KEY = `${PREFIX}index`;
const MAX_CHARS = 2_000_000;
export const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;

type IndexEntry = [key: string, savedAt: number, size: number];

function readIndex(): IndexEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(index: IndexEntry[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* index is only an optimisation for eviction */
  }
}

export function readPersisted(key: string): { value: string; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const entry = readIndex().find(e => e[0] === key);
    if (!entry) return null;
    return { value: raw, savedAt: entry[1] };
  } catch {
    return null;
  }
}

export function writePersisted(key: string, value: string): void {
  if (value.length > MAX_CHARS / 3) return; // a single huge page isn't worth the budget
  let index = readIndex().filter(e => e[0] !== key);
  let total = index.reduce((sum, e) => sum + e[2], 0) + value.length;
  while (total > MAX_CHARS && index.length > 0) {
    const [oldKey, , size] = index.shift()!; // oldest first
    try { localStorage.removeItem(PREFIX + oldKey); } catch { /* ignore */ }
    total -= size;
  }
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Quota exceeded: drop the older half and give up for this write.
    for (const [oldKey] of index.splice(0, Math.ceil(index.length / 2))) {
      try { localStorage.removeItem(PREFIX + oldKey); } catch { /* ignore */ }
    }
    writeIndex(index);
    return;
  }
  index.push([key, Date.now(), value.length]);
  writeIndex(index);
}
