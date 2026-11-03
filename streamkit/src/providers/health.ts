// health.ts - Remembers which providers keep failing so they sit out for a
// while instead of slowing every lookup, plus which provider last worked for
// a title so it can be tried first next time. Both survive restarts.

interface Health { fails: number; until: number }

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ProviderHealthOptions {
  storageKey: string;
  failsBeforeCooldown?: number;
  cooldownMs?: number;
  store?: KeyValueStore;
  now?: () => number;
}

function defaultStore(): KeyValueStore | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export class ProviderHealth {
  private readonly health: Record<string, Health>;
  private readonly store: KeyValueStore | undefined;
  private readonly failsBeforeCooldown: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private readonly opts: ProviderHealthOptions;

  constructor(opts: ProviderHealthOptions) {
    this.opts = opts;
    this.store = opts.store ?? defaultStore();
    this.failsBeforeCooldown = opts.failsBeforeCooldown ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.health = readJson<Record<string, Health>>(this.store, opts.storageKey, {});
  }

  isCoolingDown(id: string): boolean {
    return (this.health[id]?.until ?? 0) > this.now();
  }

  /** One success brings a provider straight back; repeated failures bench it. */
  record(id: string, ok: boolean): void {
    const h = this.health[id] ?? { fails: 0, until: 0 };
    if (ok) {
      if (h.fails === 0 && h.until === 0) return;
      this.health[id] = { fails: 0, until: 0 };
    } else {
      const fails = h.fails + 1;
      this.health[id] = { fails, until: fails >= this.failsBeforeCooldown ? this.now() + this.cooldownMs : 0 };
    }
    writeJson(this.store, this.opts.storageKey, this.health);
  }
}

export class LastGoodStore {
  private readonly map: Record<string, string>;
  private readonly store: KeyValueStore | undefined;
  private readonly storageKey: string;
  private readonly max: number;

  constructor(storageKey: string, max = 300, store?: KeyValueStore) {
    this.storageKey = storageKey;
    this.max = max;
    this.store = store ?? defaultStore();
    this.map = readJson<Record<string, string>>(this.store, storageKey, {});
  }

  get(key: string): string | undefined {
    return this.map[key];
  }

  remember(key: string, providerId: string | undefined): void {
    if (!providerId || this.map[key] === providerId) return;
    delete this.map[key]; // re-insert so the newest entry is last
    this.map[key] = providerId;
    const keys = Object.keys(this.map);
    if (keys.length > this.max) keys.slice(0, keys.length - this.max).forEach(k => delete this.map[k]);
    writeJson(this.store, this.storageKey, this.map);
  }
}

function readJson<T>(store: KeyValueStore | undefined, key: string, fallback: T): T {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(store: KeyValueStore | undefined, key: string, value: unknown): void {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
