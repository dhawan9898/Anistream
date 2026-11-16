// siteConfig.ts - Where the streaming site lives, changeable without an app release.
//
// The site has moved address before, and an app that only knows the old one cannot load anything
// until a new APK is installed. So the address is also read from a small JSON file in the
// repository (site-config.json: { "host": "https://example.tv" }): the last good copy is saved and
// applies at once on the next start, and a fresh one is fetched in the background. Only a plain
// https origin is accepted; anything else leaves the built-in address in use.
import { Capacitor } from '@capacitor/core';
import { DEFAULT_REMOTE_HOST, REMOTE_HOST, setRemoteHost } from './aniCliCore.ts';
import { ExoPlayerPlugin } from '../plugins/exoPlayerPlugin.ts';

const CONFIG_URL = 'https://raw.githubusercontent.com/dhawan9898/Anistream/main/site-config.json';
const STORAGE_KEY = 'anistream_site_config';
const REFRESH_MS = 3 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

/** The origin in `value` when it is a plain https address (no credentials, path or query), else null. */
export function parseSiteHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function apply(host: string): void {
  if (host === REMOTE_HOST) return;
  setRemoteHost(host);
  // The player resolves next episodes natively, with its own copy of the address.
  if (Capacitor.isNativePlatform()) ExoPlayerPlugin.setSiteHost({ host }).catch(() => undefined);
}

/** Applies the saved address, then refreshes it when the saved copy is a few hours old. Never throws. */
export async function loadSiteConfig(url: string = CONFIG_URL, fetchImpl: typeof fetch = fetch): Promise<void> {
  let fetchedAt = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { host?: unknown; fetchedAt?: unknown } | null;
    const host = parseSiteHost(saved?.host);
    if (host) {
      apply(host);
      fetchedAt = Number(saved?.fetchedAt) || 0;
    }
  } catch {
    // no saved copy
  }
  if (Date.now() - fetchedAt < REFRESH_MS) return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchImpl(url, { signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(timer));
    if (!res.ok) return;
    const host = parseSiteHost(((await res.json()) as { host?: unknown } | null)?.host) ?? DEFAULT_REMOTE_HOST;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ host, fetchedAt: Date.now() })); } catch { /* storage unavailable */ }
    apply(host);
  } catch {
    // offline or unreachable: keep what we have
  }
}
