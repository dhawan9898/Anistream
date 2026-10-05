// http.ts - The one place network requests go through, so every caller gets
// the same resilience instead of each service rolling its own:
//
//  - a hard timeout per attempt (Promise.race rather than an AbortSignal:
//    the native CapacitorHttp fetch ignores signals), with the timer always
//    cleared so finished requests don't leave timers behind;
//  - retries with exponential backoff + jitter, only for failures that can
//    plausibly succeed on a second try (network errors, timeouts, 408/425/
//    429/5xx) - a 404 or 403 fails fast;
//  - a cap on concurrent requests, so a screen that fans out (genre rails,
//    suggestions) can't flood the upstream site and trip its rate limiting;
//  - for GETs: in-flight de-duplication (two screens asking for the same
//    page share one request) and an optional short-lived response cache.

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface RequestPolicy {
  // Per-attempt timeout.
  timeoutMs?: number;
  // Extra attempts after the first one, for retryable failures only.
  retries?: number;
}

export interface CachedGetPolicy extends RequestPolicy {
  // How long a successful response is reused. 0 disables caching (in-flight
  // requests are still shared).
  ttlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5000;
const MAX_CONCURRENT = 6;
const CACHE_MAX_ENTRIES = 150;

// ------------------------------------------------------------ concurrency

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// ---------------------------------------------------------------- request

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoffDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, BACKOFF_MAX_MS);
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return exp / 2 + Math.random() * (exp / 2);
}

function fetchTimed(url: string, init: RequestInit | undefined, ms: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms: ${url}`)), ms);
  });
  return Promise.race([fetch(url, init), timeout]).finally(() => clearTimeout(timer));
}

// Resolves with an ok Response or throws (HttpError for a non-ok status).
export async function request(url: string, init?: RequestInit, policy: RequestPolicy = {}): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = policy.retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; ; attempt++) {
    let retryAfter: string | null = null;
    let failure: unknown;
    try {
      const res = await withSlot(() => fetchTimed(url, init, timeoutMs));
      if (res.ok) return res;
      failure = new HttpError(res.status, url);
      if (!isRetryableStatus(res.status)) throw failure;
      retryAfter = res.headers.get('Retry-After');
    } catch (err) {
      if (err instanceof HttpError && !isRetryableStatus(err.status)) throw err;
      failure = err;
    }
    if (attempt >= retries) throw failure;
    await sleep(backoffDelay(attempt, retryAfter));
  }
}

// ------------------------------------------------------------ cached GETs

interface CacheEntry {
  value: unknown;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function readCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh recency so the Map's insertion order works as an LRU.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

function writeCache(key: string, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cache.set(key, { value, expires: Date.now() + ttlMs });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cachedGet<T>(
  kind: string,
  url: string,
  init: RequestInit | undefined,
  policy: CachedGetPolicy,
  read: (res: Response) => Promise<T>
): Promise<T> {
  const key = `${kind} ${url}`;
  const hit = readCache<T>(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const run = request(url, init, policy)
    .then(read)
    .then(value => {
      writeCache(key, value, policy.ttlMs ?? 0);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

export function getText(url: string, init?: RequestInit, policy: CachedGetPolicy = {}): Promise<string> {
  return cachedGet('text', url, init, policy, res => res.text());
}

export function getJson<T = any>(url: string, init?: RequestInit, policy: CachedGetPolicy = {}): Promise<T> {
  return cachedGet('json', url, init, policy, res => res.json() as Promise<T>);
}

// Drops cached responses whose URL contains `fragment` (e.g. after the user
// explicitly asks to retry, so they get a fresh answer, not the cached one).
export function invalidateCache(fragment: string): void {
  for (const key of Array.from(cache.keys())) {
    if (key.includes(fragment)) cache.delete(key);
  }
}
