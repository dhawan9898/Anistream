// offlineStore.ts - IndexedDB storage behind the app's offline support.
//
// Two object stores in one database:
//   cache      key -> { value, savedAt }   site pages, episode lists, title
//                                          details: whatever was viewed, so it
//                                          can be shown again without a network
//   downloads  id  -> DownloadRecord       metadata for downloaded episodes
//
// IndexedDB is async and holds far more than localStorage (which the cache
// used before, capped at ~2M characters). Every call degrades to "nothing
// stored" when IndexedDB is missing or blocked, so callers never need to
// handle storage errors.

const DB_NAME = 'anistream-offline';
const DB_VERSION = 1;

export type StoreName = 'cache' | 'downloads';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
        }
        if (!db.objectStoreNames.contains('downloads')) db.createObjectStore('downloads', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab/version asked to upgrade: let go so it can.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(db => new Promise<T | null>(resolve => {
    if (!db) return resolve(null);
    try {
      const request = work(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | null> {
  return run<T | undefined>(store, 'readonly', s => s.get(key) as IDBRequest<T | undefined>).then(v => v ?? null);
}

export async function idbPut(store: StoreName, value: object): Promise<boolean> {
  return (await run(store, 'readwrite', s => s.put(value))) !== null;
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  await run(store, 'readwrite', s => s.delete(key));
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return (await run<T[]>(store, 'readonly', s => s.getAll() as IDBRequest<T[]>)) ?? [];
}

export async function idbClear(store: StoreName): Promise<void> {
  await run(store, 'readwrite', s => s.clear());
}

// ---------------------------------------------------------------- cache store

export interface CachedValue<T> {
  value: T;
  savedAt: number;
}

interface CacheRow<T> extends CachedValue<T> {
  key: string;
}

/** The saved copy of `key` with its age, however old (callers decide how stale is too stale). */
export async function cacheRead<T>(key: string): Promise<CachedValue<T> | null> {
  const row = await idbGet<CacheRow<T>>('cache', key);
  return row ? { value: row.value, savedAt: row.savedAt } : null;
}

export function cacheWrite<T>(key: string, value: T): Promise<boolean> {
  const row: CacheRow<T> = { key, value, savedAt: Date.now() };
  return idbPut('cache', row);
}

/** Drops entries older than maxAgeMs, then the oldest beyond maxEntries. */
export async function cachePrune(maxAgeMs: number, maxEntries: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      const cutoff = Date.now() - maxAgeMs;
      const keys: { key: string; savedAt: number }[] = [];
      const cursor = store.index('savedAt').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          // `keys` is oldest first: drop the overflow from the front.
          for (let i = 0; i < keys.length - maxEntries; i++) store.delete(keys[i].key);
          return;
        }
        const row = c.value as CacheRow<unknown>;
        if (row.savedAt < cutoff) c.delete();
        else keys.push({ key: row.key, savedAt: row.savedAt });
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
