// errorReporter.ts - Sends what goes wrong in the app to the app_errors table (supabase/errors.sql),
// so failures seen on the phones can be looked at and fixed: crashes, screen errors, provider and
// playback failures, failed requests and sync problems.
//
// Reporting must never make things worse, so:
// - nothing here throws or awaits in the caller: reportError() only queues;
// - the same error is sent once per app session (later sightings are counted, not resent) and a
//   session sends at most MAX_PER_SESSION reports;
// - reports wait in storage while offline and go out on the next start;
// - URLs lose their query string (API keys, tokens) and messages are capped in length;
// - it is a no-op until configureErrorReporter() is called with a project, so tests and unconfigured
//   builds send nothing.
//
// The same file is used by AniStream and CineStream.

export type ErrorKind =
  | 'crash' | 'error' | 'render' | 'provider' | 'source' | 'playback' | 'network' | 'sync' | 'image' | 'download' | 'update';

export interface ErrorReporterConfig {
  app: string;
  url?: string;
  anonKey?: string;
  version: string;
  /** Short description of the device and platform. */
  device: string;
  /** The signed-in user's token, so reports carry their account; null when signed out. */
  accessToken?: () => string | null;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

interface Report {
  occurred_at: string;
  app: string;
  app_version: string;
  device: string;
  session_id: string;
  kind: ErrorKind;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  fingerprint: string;
  occurrences: number;
}

const MAX_PER_SESSION = 150;
const MAX_QUEUED = 60;
const FLUSH_DELAY_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;

let config: ErrorReporterConfig | null = null;
let queue: Report[] = [];
const seen = new Map<string, Report>();
let sentThisSession = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const QUEUE_KEY = () => `${config?.app ?? 'app'}_error_queue`;

/** Removes query strings and fragments from every URL in a text (keys and tokens live there). */
export function scrubUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Same error, same fingerprint: digits, ids and URLs are blurred so variants group together. */
export function fingerprintOf(kind: string, message: string, stack?: string): string {
  const normal = message
    .replace(/https?:\/\/([^/\s]+)[^\s]*/g, '$1')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 300);
  const frame = (stack ?? '').split('\n').map(l => l.trim()).find(l => /^at\s|@/.test(l))?.replace(/:\d+:\d+\)?$/, '') ?? '';
  let h = 5381;
  for (const ch of `${kind}|${normal}|${frame}`) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return `${kind}:${(h >>> 0).toString(36)}`;
}

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try { return { message: JSON.stringify(error) ?? String(error) }; } catch { return { message: String(error) }; }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return clip(scrubUrls(value), 500);
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1));
  if (value instanceof Error) return describe(value).message;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = /token|password|secret|authorization|apikey|cookie/i.test(k) ? '[removed]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function persist(): void {
  try {
    const s = config?.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    if (queue.length) s?.setItem(QUEUE_KEY(), JSON.stringify(queue.slice(-MAX_QUEUED))); else s?.removeItem(QUEUE_KEY());
  } catch { /* storage full or unavailable: the queue lives in memory only */ }
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (!config || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, delay);
}

/** Sends what is queued. Called on a timer and when the app goes to the background. */
export async function flush(keepalive = false): Promise<void> {
  const c = config;
  if (!c || flushing || queue.length === 0) return;
  const base = (c.url ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) || (c.anonKey ?? '').length < 20) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  flushing = true;
  const batch = queue.slice(0, 25);
  try {
    const token = (() => { try { return c.accessToken?.() ?? null; } catch { return null; } })();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    const res = await (c.fetchImpl ?? fetch)(`${base}/rest/v1/app_errors`, {
      method: 'POST',
      headers: {
        apikey: c.anonKey!,
        Authorization: `Bearer ${token ?? c.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(batch),
      signal: ctl.signal,
      keepalive
    }).finally(() => clearTimeout(timer));
    // Sent, or refused for good (a 4xx other than an expired token): either way they leave the queue,
    // so one bad report cannot block the rest forever.
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401)) {
      queue = queue.slice(batch.length);
      persist();
    }
  } catch {
    // offline or the server is down: keep them for later
  } finally {
    flushing = false;
    if (queue.length) scheduleFlush(30_000);
  }
}

/**
 * Records a failure. `context` says what was being done (title, provider, URL...); it is cleaned of
 * query strings and secrets before it leaves the device. Never throws.
 */
export function reportError(kind: ErrorKind, error: unknown, context?: Record<string, unknown>): void {
  try {
    if (!config) return;
    const { message: raw, stack } = describe(error);
    const message = clip(scrubUrls(raw || 'Unknown error'), 2000);
    const fingerprint = fingerprintOf(kind, message, stack);
    const earlier = seen.get(fingerprint);
    if (earlier) {
      // Already reported this session: count it. Still queued -> the count goes with it.
      earlier.occurrences = Math.min(earlier.occurrences + 1, 100000);
      if (queue.includes(earlier)) persist();
      return;
    }
    if (sentThisSession >= MAX_PER_SESSION) return;
    sentThisSession++;
    const report: Report = {
      occurred_at: new Date().toISOString(),
      app: config.app,
      app_version: config.version,
      device: clip(config.device, 200),
      session_id: sessionId,
      kind,
      message,
      stack: stack ? clip(scrubUrls(stack), 20000) : undefined,
      context: context ? (sanitize(context) as Record<string, unknown>) : undefined,
      fingerprint,
      occurrences: 1
    };
    seen.set(fingerprint, report);
    queue.push(report);
    if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
    persist();
    scheduleFlush(kind === 'crash' ? 1_000 : FLUSH_DELAY_MS);
  } catch {
    // reporting must never break the app
  }
}

/** Starts reporting: restores reports left from an earlier run and sends them. */
export function configureErrorReporter(next: ErrorReporterConfig): void {
  config = next;
  try {
    const s = next.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    const saved = JSON.parse(s?.getItem(QUEUE_KEY()) || '[]') as Report[];
    if (Array.isArray(saved)) queue = [...saved.filter(r => r && typeof r.message === 'string'), ...queue].slice(-MAX_QUEUED);
  } catch { /* nothing saved */ }
  if (queue.length) scheduleFlush(3_000);
}

/** Catches what nothing else catches: uncaught errors and unhandled promise rejections. */
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', e => {
    // A resource that failed to load (an <img>) is not a script error.
    if (!(e instanceof ErrorEvent)) return;
    reportError('error', e.error ?? e.message, { source: e.filename ? scrubUrls(e.filename) : undefined, line: e.lineno, column: e.colno });
  });
  window.addEventListener('unhandledrejection', e => {
    const reason = (e as PromiseRejectionEvent).reason;
    // Cancelled requests are not failures.
    if (reason instanceof Error && reason.name === 'AbortError') return;
    reportError('error', reason, { unhandledRejection: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(true);
  });
}

/** For tests. */
export function _resetErrorReporterForTests(): void {
  config = null;
  queue = [];
  seen.clear();
  sentThisSession = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = false;
}
