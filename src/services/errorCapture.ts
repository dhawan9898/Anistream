// errorCapture.ts - Turns on error reporting for AniStream (see errorReporter.ts and
// supabase/errors.sql): which failures are caught where.
import { Capacitor } from '@capacitor/core';
import { setRequestFailureListener } from 'streamkit/core/http.ts';
import { setRenderErrorListener } from 'streamkit/ui/ErrorBoundary.tsx';
import { configureErrorReporter, installGlobalErrorHandlers, reportError } from './errorReporter.ts';
import { cloud } from './cloudAccount.ts';
import { DownloadsPlugin } from '../plugins/downloadsPlugin.ts';
import { ExoPlayerPlugin } from '../plugins/exoPlayerPlugin.ts';

const APP = 'anistream';

function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const android = ua.match(/\(Linux; ([^)]*?)(?: Build\/[^;)]*)?[;)]/)?.[1];
  return `${Capacitor.getPlatform()}${android ? ` (${android})` : ''}`;
}

/** "HTTP 404 from api.example.com/3/tv/12" - the host and path say which call failed; no query. */
function describeRequest(url: string, status?: number, message?: string): string {
  let where = url;
  try { const u = new URL(url); where = u.host + u.pathname; } catch { /* keep it as it is */ }
  return `${status ? `HTTP ${status}` : (message ?? 'Request failed').replace(/:\s*https?:\/\/\S+/, '')} from ${where}`;
}

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The native crash handler saves the last crash to a file; it is sent on the next start, once. */
async function sendSavedCrash(): Promise<void> {
  const { report } = await DownloadsPlugin.getCrashReport();
  if (!report) return;
  const key = `${APP}_crash_reported`;
  const id = hashOf(report);
  try { if (localStorage.getItem(key) === id) return; } catch { /* storage unavailable: may send it twice */ }
  const [header = '', when = '', , ...trace] = report.split('\n');
  const stack = trace.join('\n');
  const first = trace.find(l => l.trim()) ?? 'Native crash';
  reportError('crash', Object.assign(new Error(first.trim()), { stack }), { device: header, when });
  try { localStorage.setItem(key, id); } catch { /* see above */ }
}

export function startErrorCapture(): void {
  const env = ((import.meta as { env?: Record<string, string | undefined> }).env) ?? {};
  configureErrorReporter({
    app: APP,
    url: env.VITE_SUPABASE_URL,
    anonKey: env.VITE_SUPABASE_ANON_KEY,
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?',
    device: deviceLabel(),
    accessToken: () => cloud.accessToken()
  });

  // Uncaught errors and unhandled promise rejections anywhere in the app.
  installGlobalErrorHandlers();
  // A screen that failed to render (the "unexpected problem" page).
  setRenderErrorListener((error, componentStack) => reportError('render', error, { componentStack }));
  // Requests to the catalogue, metadata and streaming sites that failed after their retries.
  setRequestFailureListener(f => reportError('network', describeRequest(f.url, f.status, f.message), { status: f.status, attempts: f.attempts }));

  // Sync problems (each distinct message once).
  let lastSyncError: string | null = null;
  cloud.subscribe(s => {
    if (s.error && s.error !== lastSyncError) reportError('sync', s.error, { signedIn: Boolean(s.user) });
    lastSyncError = s.error;
  });

  if (Capacitor.isNativePlatform()) {
    void sendSavedCrash().catch(() => undefined);
    // Every error the native player hits (it recovers by itself; this records why it had to).
    void ExoPlayerPlugin.addListener('playbackError', e => {
      const message = (e.message || 'Playback error').replace(/^Couldn't play this stream\.\s*/, '').replace(/\n+/g, ' | ');
      reportError('playback', message, { code: e.code, server: e.serverId, host: e.host, title: e.title, episode: e.episode, mode: e.mode });
    }).catch(() => undefined);
  }
}
