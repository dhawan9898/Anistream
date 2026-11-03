// persistentCache.ts - Tiered, budgeted cache shared by both apps:
//
//   L1  in-memory Map            synchronous, fastest
//   L2  localStorage             synchronous, survives restarts, size-budgeted
//   L3  IndexedDB (optional)     async, used when localStorage is full or evicted
//
// Entries carry their own TTL. `get` serves fresh entries only; `getEntry`
// also returns stale ones so callers can fall back to an old copy when the
// network is down. localStorage use is capped by `maxChars` with
// least-recently-written eviction, so the cache can never fill the WebView's
// storage quota. Every storage access is wrapped: storage can be missing,
// full or blocked.

export const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheRecord<T> {
  data: T;
  savedAt: number;
  ttlMs: number;
}

export interface CacheEntry<T> {
  data: T;
  savedAt: number;
  fresh: boolean;
}

export interface PersistentCacheOptions {
  /** localStorage key prefix for this cache, e.g. 'cinestream_cache_v5_'. */
  prefix: string;
  /** Total characters this cache may occupy in localStorage. */
  maxChars: number;
  defaultTtlMs?: number;
  /** Keys starting with this (but not with `prefix`) are older versions and are pruned. */
  legacyPrefix?: string;
  /** Enables the IndexedDB tier. */
  idb?: { dbName: string; storeName: string };
  /** Injected for tests; defaults to globalThis.localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly length: number; key(i: number): string | null };
  now?: () => number;
}

export interface PersistentCache {
  /** Fresh entry or null (expired entries are dropped). L1 then L2. */
  get<T>(key: string): T | null;
  /** Like get, then falls back to IndexedDB. */
  getAsync<T>(key: string): Promise<T | null>;
  /** Entry even when expired, for stale-on-error fallbacks. L1 then L2. */
  getEntry<T>(key: string): CacheEntry<T> | null;
  set<T>(key: string, data: T, ttlMs?: number): void;
  /** Removes this cache's entries from every tier. */
  clear(): void;
  /** Removes expired entries and entries left by older cache versions. */
  prune(): void;
}

export function createPersistentCache(opts: PersistentCacheOptions): PersistentCache {
  const now = opts.now ?? Date.now;
  const defaultTtl = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  const memory = new Map<string, CacheRecord<unknown>>();
  const maxEntryChars = Math.floor(opts.maxChars / 3);

  const ls = (): NonNullable<PersistentCacheOptions['storage']> | undefined => {
    try { return opts.storage ?? globalThis.localStorage; } catch { return undefined; }
  };
  const isFresh = (r: CacheRecord<unknown>) => now() - r.savedAt <= r.ttlMs;

  // Lazily built view of what this cache holds in localStorage, kept in step
  // with writes so the budget check never rescans storage.
  let index: Map<string, { savedAt: number; size: number }> | null = null;
  const keys = (): string[] => {
    const s = ls();
    if (!s) return [];
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(opts.prefix)) out.push(k);
    }
    return out;
  };
  const getIndex = () => {
    if (index) return index;
    index = new Map();
    const s = ls();
    for (const k of keys()) {
      try {
        const raw = s?.getItem(k);
        if (raw) index.set(k, { savedAt: (JSON.parse(raw) as CacheRecord<unknown>).savedAt ?? 0, size: raw.length });
      } catch { s?.removeItem(k); }
    }
    return index;
  };

  const removeStored = (storageKey: string) => {
    try { ls()?.removeItem(storageKey); } catch { /* ignore */ }
    index?.delete(storageKey);
  };

  const readRecord = <T,>(key: string): CacheRecord<T> | null => {
    const m = memory.get(key) as CacheRecord<T> | undefined;
    if (m) return m;
    try {
      const raw = ls()?.getItem(opts.prefix + key);
      if (!raw) return null;
      const record = JSON.parse(raw) as CacheRecord<T>;
      if (typeof record.savedAt !== 'number') return null;
      memory.set(key, record);
      return record;
    } catch {
      return null;
    }
  };

  // IndexedDB tier ------------------------------------------------------
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const getIDB = (): Promise<IDBDatabase | null> => {
    const cfg = opts.idb;
    if (!cfg || typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      const req = indexedDB.open(cfg.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(cfg.storeName)) req.result.createObjectStore(cfg.storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  };

  function persistToLocalStorage(storageKey: string, record: CacheRecord<unknown>): boolean {
    const s = ls();
    if (!s) return false;
    const raw = JSON.stringify(record);
    if (raw.length > maxEntryChars) return false; // one huge entry isn't worth the budget
    const idx = getIndex();
    const prior = idx.get(storageKey);
    let total = Array.from(idx.values()).reduce((sum, e) => sum + e.size, 0) - (prior?.size ?? 0) + raw.length;
    if (total > opts.maxChars) {
      const oldestFirst = Array.from(idx.entries())
        .filter(([k]) => k !== storageKey)
        .sort((a, b) => a[1].savedAt - b[1].savedAt);
      for (const [k, e] of oldestFirst) {
        if (total <= opts.maxChars) break;
        removeStored(k);
        total -= e.size;
      }
    }
    const tryWrite = () => { s.setItem(storageKey, raw); idx.set(storageKey, { savedAt: record.savedAt, size: raw.length }); };
    try {
      tryWrite();
      return true;
    } catch {
      // Quota exceeded: drop expired entries, then the older half, and retry once.
      prune();
      const older = Array.from(idx.entries()).filter(([k]) => k !== storageKey).sort((a, b) => a[1].savedAt - b[1].savedAt);
      older.slice(0, Math.ceil(older.length / 2)).forEach(([k]) => removeStored(k));
      try { tryWrite(); return true; } catch { return false; }
    }
  }

  function prune(): void {
    const s = ls();
    if (!s) return;
    const t = now();
    const legacy = opts.legacyPrefix;
    const all: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && (k.startsWith(opts.prefix) || (legacy && k.startsWith(legacy)))) all.push(k);
    }
    for (const k of all) {
      if (!k.startsWith(opts.prefix)) { removeStored(k); continue; } // older cache version
      try {
        const raw = s.getItem(k);
        if (!raw) continue;
        const r = JSON.parse(raw) as CacheRecord<unknown>;
        if (t - r.savedAt > r.ttlMs) removeStored(k);
      } catch { removeStored(k); }
    }
  }

  // Methods never use `this`, so apps can destructure them (const { get } = cache).
  const api: PersistentCache = {
    get<T>(key: string): T | null {
      const r = readRecord<T>(key);
      if (!r) return null;
      if (isFresh(r)) return r.data;
      memory.delete(key);
      removeStored(opts.prefix + key);
      return null;
    },

    getEntry<T>(key: string): CacheEntry<T> | null {
      const r = readRecord<T>(key);
      return r ? { data: r.data, savedAt: r.savedAt, fresh: isFresh(r) } : null;
    },

    async getAsync<T>(key: string): Promise<T | null> {
      const sync = api.get<T>(key);
      if (sync !== null) return sync;
      try {
        const db = await getIDB();
        const cfg = opts.idb;
        if (!db || !cfg) return null;
        return await new Promise<T | null>(resolve => {
          const req = db.transaction(cfg.storeName, 'readonly').objectStore(cfg.storeName).get(key);
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const record = req.result as CacheRecord<T> | undefined;
            if (!record) return resolve(null);
            if (!isFresh(record)) {
              try { db.transaction(cfg.storeName, 'readwrite').objectStore(cfg.storeName).delete(key); } catch { /* ignore */ }
              return resolve(null);
            }
            memory.set(key, record);
            persistToLocalStorage(opts.prefix + key, record);
            resolve(record.data);
          };
        });
      } catch {
        return null;
      }
    },

    set<T>(key: string, data: T, ttlMs: number = defaultTtl): void {
      const record: CacheRecord<T> = { data, savedAt: now(), ttlMs };
      memory.set(key, record);
      persistToLocalStorage(opts.prefix + key, record);
      const cfg = opts.idb;
      if (cfg) {
        getIDB().then(db => {
          try { db?.transaction(cfg.storeName, 'readwrite').objectStore(cfg.storeName).put(record, key); } catch { /* ignore */ }
        }).catch(() => undefined);
      }
    },

    clear(): void {
      memory.clear();
      index = null;
      const s = ls();
      const legacy = opts.legacyPrefix;
      if (s) {
        const all: string[] = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k && (k.startsWith(opts.prefix) || (legacy && k.startsWith(legacy)))) all.push(k);
        }
        all.forEach(k => { try { s.removeItem(k); } catch { /* ignore */ } });
      }
      const cfg = opts.idb;
      if (cfg) {
        getIDB().then(db => {
          try { db?.transaction(cfg.storeName, 'readwrite').objectStore(cfg.storeName).clear(); } catch { /* ignore */ }
        }).catch(() => undefined);
      }
    },

    prune
  };
  return api;
}
