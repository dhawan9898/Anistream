// cloudSync.ts - Sign-in and sync of history, My List and settings between devices.
//
// The data lives in one Supabase table (see supabase/schema.sql): a row per user, app and
// collection ("history", "bookmarks", ...), holding that collection as JSON. Row-level security
// lets a signed-in user read and write only their own rows, so the project's public ("anon") key
// can ship in the app. Supabase is used over plain HTTPS; no SDK is bundled.
//
// A sync is pull -> merge -> push. Merging is three-way against what this device last synced, so a
// title removed on one phone is removed on the other instead of being brought back, and the same
// title watched on two devices keeps whichever progress is newer. Nothing here throws into the app:
// a failed sync leaves local data as it was and is retried on the next trigger.
//
// The same file is used by AniStream and CineStream (each passes its own collections).

// ---- merging (pure) -------------------------------------------------------------------

type Json = unknown;
type Item = Record<string, Json>;

export type CollectionSpec =
  /** An array of records. `key` identifies one; `stamp` (ms) says which copy is newer. */
  | { type: 'list'; key: (item: Item) => string; stamp?: (item: Item) => number }
  /** An object used as a map of records; `stamp` as above. */
  | { type: 'map'; stamp?: (value: Json) => number }
  /** One value replaced as a whole (settings). */
  | { type: 'blob' };

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `base` is what both sides agreed on at the last sync. An entry on one side only is new there,
 * unless base had it: then the other side removed it, and the removal wins - except over a copy
 * that was changed since.
 */
function mergeEntries(
  base: Map<string, Json>, local: Map<string, Json>, remote: Map<string, Json>, stamp?: (v: Json) => number
): Map<string, Json> {
  const out = new Map<string, Json>();
  const at = (v: Json) => (stamp ? Number(stamp(v)) || 0 : 0);
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(key);
    const r = remote.get(key);
    if (l !== undefined && r !== undefined) {
      out.set(key, at(r) > at(l) ? r : l);
    } else {
      const only = (l ?? r) as Json;
      const known = base.get(key);
      const changedSince = known !== undefined && (stamp ? at(only) > at(known) : !same(only, known));
      if (known === undefined || changedSince) out.set(key, only);
    }
  }
  return out;
}

const asList = (v: Json): Item[] => (Array.isArray(v) ? v.filter((x): x is Item => !!x && typeof x === 'object') : []);
const asMap = (v: Json): Record<string, Json> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {});

/** The merged value of one collection. `remote === undefined` means the cloud has nothing yet. */
export function mergeCollection(spec: CollectionSpec, base: Json, local: Json, remote: Json): Json {
  if (remote === undefined || remote === null) return local;
  if (spec.type === 'blob') {
    // Changed here since the last sync: this device wins. Otherwise take the cloud's copy.
    return base !== undefined && same(local, base) ? remote : (base === undefined ? remote : local);
  }
  if (spec.type === 'map') {
    const toMap = (v: Json) => new Map(Object.entries(asMap(v)));
    return Object.fromEntries(mergeEntries(toMap(base), toMap(local), toMap(remote), spec.stamp));
  }
  const toMap = (v: Json) => new Map(asList(v).map(item => [spec.key(item), item as Json]));
  const merged = [...mergeEntries(toMap(base), toMap(local), toMap(remote), spec.stamp as ((v: Json) => number) | undefined).values()] as Item[];
  const stamp = spec.stamp;
  return stamp ? merged.sort((a, b) => (Number(stamp(b)) || 0) - (Number(stamp(a)) || 0)) : merged;
}

// ---- Supabase over HTTPS --------------------------------------------------------------

export interface CloudUser { id: string; email: string }
interface Session { accessToken: string; refreshToken: string; expiresAt: number; user: CloudUser }

export interface CloudStatus {
  /** False when the app was built without a Supabase project: the account section stays hidden. */
  configured: boolean;
  user: CloudUser | null;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

export interface CloudSyncOptions {
  /** Row label in the shared table, e.g. "cinestream". */
  app: string;
  url?: string;
  anonKey?: string;
  collections: Record<string, CollectionSpec>;
  /** The app's current data, one entry per collection. */
  read: () => Promise<Record<string, Json>>;
  /** Replaces the app's data with the merged result. */
  write: (state: Record<string, Json>) => Promise<void>;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEBOUNCE_MS = 4_000;

export function createCloudSync(options: CloudSyncOptions) {
  const base = (options.url ?? '').replace(/\/+$/, '');
  const anonKey = options.anonKey ?? '';
  const configured = /^https:\/\//.test(base) && anonKey.length > 20;
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);
  const storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const SESSION_KEY = `${options.app}_cloud_session`;
  const BASE_KEY = `${options.app}_cloud_base`;
  const SYNCED_KEY = `${options.app}_cloud_synced_at`;

  const load = <T,>(key: string): T | null => {
    try { return JSON.parse(storage?.getItem(key) || 'null') as T | null; } catch { return null; }
  };
  const save = (key: string, value: unknown) => {
    try {
      if (value === null) storage?.removeItem(key); else storage?.setItem(key, JSON.stringify(value));
    } catch { /* storage full or unavailable: the next sync starts from an older base */ }
  };

  let session = load<Session>(SESSION_KEY);
  let status: CloudStatus = { configured, user: session?.user ?? null, syncing: false, lastSyncedAt: load<number>(SYNCED_KEY), error: null };
  const listeners = new Set<(s: CloudStatus) => void>();
  const setStatus = (patch: Partial<CloudStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach(l => { try { l(status); } catch { /* a listener must not break sync */ } });
  };

  async function request(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${init.token ?? anonKey}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctl.signal
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!res.ok) {
        const d = (data ?? {}) as Record<string, unknown>;
        const message = d.msg ?? d.error_description ?? d.message ?? d.error ?? `Request failed (HTTP ${res.status})`;
        throw Object.assign(new Error(String(message)), { status: res.status });
      }
      return data;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('The server took too long to answer');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function adopt(data: unknown): Session | null {
    const d = (data ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number; user?: { id?: string; email?: string } };
    if (!d.access_token || !d.refresh_token || !d.user?.id) return null;
    session = {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      user: { id: d.user.id, email: d.user.email ?? '' }
    };
    save(SESSION_KEY, session);
    setStatus({ user: session.user, error: null });
    return session;
  }

  function forget(): void {
    session = null;
    save(SESSION_KEY, null);
    save(BASE_KEY, null);
    save(SYNCED_KEY, null);
    setStatus({ user: null, lastSyncedAt: null, syncing: false });
  }

  /** A token good for the next request, refreshed when it is about to run out. */
  async function token(): Promise<string | null> {
    if (!session) return null;
    if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
    try {
      return adopt(await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refreshToken } }))?.accessToken ?? null;
    } catch (e) {
      // The refresh token was revoked or expired: signed out. Anything else (offline): try again later.
      const code = (e as { status?: number }).status;
      if (code === 400 || code === 401 || code === 403) forget();
      throw e;
    }
  }

  let running: Promise<void> | null = null;
  let applying = false;
  let again = false;

  async function runSync(): Promise<void> {
    const bearer = await token();
    if (!bearer || !session) return;
    const userId = session.user.id;
    const rows = (await request(`/rest/v1/user_data?app=eq.${encodeURIComponent(options.app)}&select=kind,data`, { token: bearer })) as Array<{ kind: string; data: Json }> | null;
    const remote: Record<string, Json> = {};
    for (const row of rows ?? []) remote[row.kind] = row.data;

    const local = await options.read();
    const known = load<{ user: string; state: Record<string, Json> }>(BASE_KEY);
    const baseState = known?.user === userId ? known.state : {};
    const merged: Record<string, Json> = {};
    for (const [kind, spec] of Object.entries(options.collections)) {
      merged[kind] = mergeCollection(spec, baseState[kind], local[kind], remote[kind]);
    }

    if (Object.keys(merged).some(kind => !same(merged[kind], local[kind]))) {
      applying = true;
      try { await options.write(merged); } finally { applying = false; }
    }
    const changed = Object.keys(merged).filter(kind => merged[kind] !== undefined && !same(merged[kind], remote[kind]));
    if (changed.length > 0) {
      await request('/rest/v1/user_data?on_conflict=user_id,app,kind', {
        method: 'POST',
        token: bearer,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: changed.map(kind => ({ user_id: userId, app: options.app, kind, data: merged[kind], updated_at: new Date().toISOString() }))
      });
    }
    save(BASE_KEY, { user: userId, state: merged });
    save(SYNCED_KEY, Date.now());
    setStatus({ lastSyncedAt: Date.now(), error: null });
  }

  /** Syncs now. Calls made while one is running are folded into one more run after it. */
  function syncNow(): Promise<void> {
    if (!configured || !session) return Promise.resolve();
    if (running) { again = true; return running; }
    setStatus({ syncing: true });
    running = runSync()
      .catch(e => { setStatus({ error: e instanceof Error ? e.message : 'Sync failed' }); })
      .finally(() => {
        running = null;
        setStatus({ syncing: false });
        if (again) { again = false; void syncNow(); }
      });
    return running;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Call when local data changed: syncs a few seconds later, once, however many changes arrive. */
  function schedule(): void {
    if (!configured || !session || applying) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void syncNow(); }, DEBOUNCE_MS);
  }

  async function signIn(email: string, password: string): Promise<void> {
    if (!adopt(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } }))) {
      throw new Error('Sign-in failed');
    }
    await syncNow();
  }

  /** Creates the account. `needsConfirmation`: Supabase sent a confirmation email; sign in after opening it. */
  async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const signedIn = adopt(await request('/auth/v1/signup', { method: 'POST', body: { email: email.trim(), password } }));
    if (!signedIn) return { needsConfirmation: true };
    await syncNow();
    return { needsConfirmation: false };
  }

  async function signOut(): Promise<void> {
    const bearer = session?.accessToken;
    forget();
    if (bearer) await request('/auth/v1/logout', { method: 'POST', token: bearer }).catch(() => undefined);
  }

  return {
    getStatus: () => status,
    subscribe(listener: (s: CloudStatus) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    signIn, signUp, signOut, syncNow, schedule
  };
}

export type CloudSync = ReturnType<typeof createCloudSync>;
