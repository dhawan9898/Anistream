// aniCliCore.ts - Port of ani-cli scraping & deobfuscation logic
import { Capacitor } from '@capacitor/core';
import { fetchTimed } from './http.ts';
import { MAX_STALE_MS, readPersisted, writePersisted } from './persistentCache.ts';

export interface AnimeItem {
  id: string;          // e.g. "solo-leveling-season-2-arise-from-the-shadow-19413"
  title: string;
  poster: string;
  type?: string;       // TV, Movie, OVA
  duration?: string;
  subCount?: number;
  dubCount?: number;
  description?: string;
  banner?: string;
  // Site path of the anime's own page (e.g. "/mushoku-tensei-123"), when
  // known - used to fetch its collection/suggestions.
  path?: string;
  genres?: string[];
  // Set on entries that came from MyAnimeList (Jikan) rather than the
  // streaming site: they must be matched to a real site entry by title
  // (see resolveAnime in catalogService) before episodes can be loaded.
  malId?: number;
  // Other known titles (romaji, synonyms) for matching MAL entries to the site.
  altTitles?: string[];
  // Label shown on collection entries, e.g. "Season 2".
  seasonLabel?: string;
}

export interface EpisodeItem {
  id: string;          // numeric episode id e.g. "12456"
  number: string;      // e.g. "1", "2.5", "12"
  title?: string;
  isFiller?: boolean;
}

export interface SubtitleTrack {
  src: string;
  label: string;
  default?: boolean;
}

// Chapter interval in seconds, e.g. { start: 85, end: 175 }.
export interface SkipRange {
  start: number;
  end: number;
}

export interface StreamSource {
  streamUrl: string;
  quality: string;
  subtitles: SubtitleTrack[];
  referer: string;
  masterUrl?: string;
  qualities?: { quality: string; url: string }[];
  // True only when every real source failed and streamUrl is the built-in
  // demo clip - callers must make this visible, never present it as if it
  // were the real episode.
  isFallback?: boolean;
  // Opening/ending intervals served by the embed player's own sources
  // endpoint (the same data HiAnime's "Skip Intro"/"Skip Outro" uses).
  // Absent when the server didn't tag this episode.
  intro?: SkipRange;
  outro?: SkipRange;
  // WebVTT file mapping time ranges to regions of thumbnail sprite sheets
  // (the player's own scrub-preview data), when the embed offers one.
  spriteVtt?: string;
}

// The sources payload carries chapter markers as { start, end } (seconds);
// some mirrors send [start, end] or numeric strings instead. Untagged
// episodes come back as { start: 0, end: 0 } - treat that as "no data".
export function parseSkipRange(raw: any): SkipRange | undefined {
  if (!raw) return undefined;
  const pair = Array.isArray(raw) ? raw : [raw.start ?? raw.startTime, raw.end ?? raw.endTime];
  const start = Number(pair[0]);
  const end = Number(pair[1]);
  if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) return undefined;
  return { start, end };
}

// 1. Deobfuscator using exact ani-cli XOR algorithm: "otaku-embed-v1"
export function deobfuscateBlob(base64Blob: string): string {
  try {
    const raw = atob(base64Blob);
    const key = "otaku-embed-v1";
    let output = "";
    for (let i = 0; i < raw.length; i++) {
      const byte = raw.charCodeAt(i);
      const keyByte = key.charCodeAt(i % key.length);
      output += String.fromCharCode(byte ^ keyByte);
    }
    return output;
  } catch (err) {
    console.error("deobfuscateBlob error:", err);
    return "";
  }
}

// Helper to resolve API URLs: the dev server proxies "/api-hianime" to
// https://hianime.at (see vite.config.ts), which only exists while running
// `npm run dev`. The built APK has no such proxy, so on a native device we
// must hit the real host directly - CapacitorHttp (enabled in
// capacitor.config.ts) routes fetch() through native networking, which
// isn't subject to the browser's CORS / forbidden-header restrictions.
const REMOTE_HOST = "https://hianime.at";

export function getApiBase(): string {
  return Capacitor.isNativePlatform() ? REMOTE_HOST : "/api-hianime";
}

// Every network step of stream resolution goes through fetchTimed (see
// http.ts) so one hung request can't leave the player spinning forever.
// Idempotent GETs against the site get one retry after a short backoff when
// the failure looks transient (network error, 429, 5xx) - a single flaky
// response shouldn't fall straight through to curated/demo fallbacks.
async function fetchWithRetry(input: string, init?: RequestInit, retries = 1): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchTimed(input, init);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(600 * (attempt + 1));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Small in-memory TTL cache with in-flight de-duplication: the home screen,
// genre rails, detail page and player all ask for the same pages/episode
// lists, and without this each of them hit the site separately (the fastest
// way to get rate-limited or IP-banned). Failures are never cached.
const responseCache = new Map<string, { expires: number; value: Promise<unknown> }>();
const CACHE_MAX_ENTRIES = 80; // pages are large strings - keep the in-memory set modest

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = responseCache.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  const value = load();
  responseCache.set(key, { expires: now + ttlMs, value });
  value.catch(() => {
    if (responseCache.get(key)?.value === value) responseCache.delete(key);
  });
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    // Map iterates in insertion order - drop the oldest entry.
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  return value;
}

const PAGE_TTL_MS = 5 * 60 * 1000;
const EPISODE_LIST_TTL_MS = 10 * 60 * 1000;

// Headers the dev proxy injects automatically; native requests need them set explicitly.
const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': `${REMOTE_HOST}/`
};

// Fetches a page of the streaming site as HTML. `path` may be a site path
// ("/genre/action") or an absolute URL on the site.
export function fetchSiteHtml(path: string): Promise<string> {
  const sitePath = path.startsWith('http') ? new URL(path).pathname + new URL(path).search : path;
  // Browse pages (home, genres) are kept on disk too; searches are not.
  const persist = !sitePath.startsWith('/search');
  return cached(`html:${sitePath}`, PAGE_TTL_MS, () => loadPersisted(`html:${sitePath}`, PAGE_TTL_MS, persist, async () => {
    const res = await fetchWithRetry(`${getApiBase()}${sitePath}`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        ...UPSTREAM_HEADERS
      }
    });
    if (!res.ok) {
      throw new Error(`GET ${sitePath} failed with HTTP ${res.status}`);
    }
    return res.text();
  }));
}

// Disk layer under the in-memory cache: a copy younger than ttlMs is used
// as is (instant cold start); otherwise the network is asked, and if that
// fails the last saved copy (up to MAX_STALE_MS old) stands in.
async function loadPersisted(
  key: string,
  ttlMs: number,
  persist: boolean,
  load: () => Promise<string>
): Promise<string> {
  const saved = persist ? readPersisted(key) : null;
  if (saved && Date.now() - saved.savedAt < ttlMs) return saved.value;
  try {
    const fresh = await load();
    if (persist) writePersisted(key, fresh);
    return fresh;
  } catch (err) {
    if (saved && Date.now() - saved.savedAt < MAX_STALE_MS) {
      console.warn(`[aniCliCore] ${key} unreachable, serving the saved copy`, err);
      return saved.value;
    }
    throw err;
  }
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Live search only - no curated/mock fallback. Throws on network failure.
export async function searchAnimeLive(query: string): Promise<AnimeItem[]> {
  const cleanKeyword = query.replace(/(^|\s)-+(\w)/g, '$1$2').trim();
  const html = await fetchSiteHtml(`/search?keyword=${encodeURIComponent(cleanKeyword)}`);
  return parseSearchResults(html);
}

// Search anime. Throws on network failure - callers show an error with a
// retry instead of placeholder results.
export async function searchAnime(query: string): Promise<AnimeItem[]> {
  if (!query.trim()) return [];
  return searchAnimeLive(query);
}

// Trending/homepage anime (same card markup as search results).
// The root "/" is just a landing page - /home is the actual suggestions feed.
// Throws when the feed can't be loaded so Home can offer a retry - never
// substitutes placeholder titles that don't exist on the site.
export async function getTrendingAnime(): Promise<AnimeItem[]> {
  // Same cached request the genre menu (catalogService.getGenres) uses.
  const results = parseSearchResults(await fetchSiteHtml('/home'));
  if (results.length === 0) throw new SourceUnavailableError('The home feed came back empty');
  return results;
}

// Parse HTML search results matching ani-cli regex patterns
export function parseSearchResults(html: string): AnimeItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  
  // Cut off sidebar like ani-cli does: `sed '/id="main-sidebar"/,$d'`
  const sidebar = doc.getElementById("main-sidebar");
  if (sidebar && sidebar.parentNode) {
    sidebar.parentNode.removeChild(sidebar);
  }

  const filmDetails = doc.querySelectorAll(".film-detail");
  const results: AnimeItem[] = [];
  const seenIds = new Set<string>();

  filmDetails.forEach((el) => {
    const titleEl = el.querySelector(".film-name a") as HTMLAnchorElement | null;
    const parentCard = el.closest(".flw-item");
    const posterEl = parentCard?.querySelector(".film-poster img") as HTMLImageElement | null;

    if (!titleEl) return;

    const href = titleEl.getAttribute("href") || "";
    const slug = href.split("/").filter(Boolean).pop() || "";
    const path = sitePathOf(href);
    const rawTitle = titleEl.getAttribute("title") || titleEl.textContent?.trim() || "";
    const title = decodeHtmlEntities(rawTitle).trim();
    const poster = posterEl?.getAttribute("data-src") || posterEl?.getAttribute("src") || "";

    // Some pages mix in non-anime cards (ad slots, "load more" tiles, slider
    // clones used for seamless looping) alongside real ones with the same
    // .film-detail markup - drop anything missing the essentials or that
    // isn't a real, distinct entry rather than surfacing it as junk.
    const isValid = slug.length > 0 && title.length > 1 && (poster.startsWith("http") || poster.startsWith("//"));
    if (!isValid || seenIds.has(slug)) return;
    seenIds.add(slug);

    const subBadge = (parentCard?.querySelector(".tick-sub") || el.querySelector(".tick-sub"))?.textContent?.trim();
    const dubBadge = (parentCard?.querySelector(".tick-dub") || el.querySelector(".tick-dub"))?.textContent?.trim();
    const epBadge = (parentCard?.querySelector(".tick-eps") || el.querySelector(".tick-eps"))?.textContent?.trim();

    results.push({
      id: slug,
      title,
      poster,
      path,
      type: parseTypeBadge(el),
      subCount: subBadge ? parseInt(subBadge, 10) : (epBadge ? parseInt(epBadge, 10) : undefined),
      // 0 = the site lists no dub for this title; undefined (other sources) = unknown.
      dubCount: dubBadge ? parseInt(dubBadge, 10) : 0
    });
  });

  return results;
}

const KNOWN_TYPES = ["TV", "Movie", "OVA", "ONA", "Special", "Music"];

function parseTypeBadge(el: Element): string {
  for (const item of Array.from(el.querySelectorAll(".fdi-item"))) {
    const text = item.textContent?.trim() || "";
    const match = KNOWN_TYPES.find(t => t.toLowerCase() === text.toLowerCase());
    if (match) return match;
  }
  return "TV";
}

// Site-relative path of a link on the streaming site ("" when not a link
// to the site itself).
export function sitePathOf(href: string): string {
  if (!href) return "";
  try {
    const url = new URL(href, REMOTE_HOST);
    const host = url.hostname.replace(/^www\./, '');
    if (host !== new URL(REMOTE_HOST).hostname && !url.pathname.startsWith('/api-hianime')) return "";
    return url.pathname.replace(/^\/api-hianime/, '');
  } catch {
    return "";
  }
}

// Fetch episodes list. Cached per anime: the detail page and the player
// both need it, and re-opening a title shouldn't refetch it.
// Throws when the list can't be loaded (failures aren't cached, so the
// next call retries) - it never invents episodes.
export function getEpisodes(animeId: string): Promise<EpisodeItem[]> {
  return cached(`episodes:${animeId}`, EPISODE_LIST_TTL_MS, async () => {
    const json = await loadPersisted(`episodes:${animeId}`, EPISODE_LIST_TTL_MS, true,
      async () => JSON.stringify(await loadEpisodes(animeId)));
    return JSON.parse(json) as EpisodeItem[];
  });
}

async function loadEpisodes(animeId: string): Promise<EpisodeItem[]> {
  let numericId = animeId.includes("-") ? animeId.split("-").pop() : animeId;
  let endpoint = `${getApiBase()}/api/theme/episode/list/${numericId}`;
  let res = await fetchWithRetry(endpoint, { headers: UPSTREAM_HEADERS });

  if (!res.ok) {
    // The site may have re-numbered the title: find it again by name, but
    // only accept the very same slug - never a different show that
    // happens to be the first search result.
    const slugBase = animeId.replace(/-[0-9]+$/, '');
    if (slugBase) {
      const found = await searchAnimeLive(slugBase.replace(/-/g, ' '));
      const same = found.find(r => r.id.replace(/-[0-9]+$/, '') === slugBase);
      const newNumericId = same?.id.split("-").pop();
      if (newNumericId && /^\d+$/.test(newNumericId) && newNumericId !== numericId) {
        endpoint = `${getApiBase()}/api/theme/episode/list/${newNumericId}`;
        res = await fetchTimed(endpoint, { headers: UPSTREAM_HEADERS });
      }
    }
  }

  if (!res.ok) {
    throw new Error(`Episodes fetch failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.html) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(data.html, "text/html");
  const epItems = doc.querySelectorAll(".ep-item");
  const episodes: EpisodeItem[] = [];

  epItems.forEach((ep) => {
    const id = ep.getAttribute("data-id") || "";
    const number = ep.getAttribute("data-number") || "";
    const title = ep.getAttribute("title") || `Episode ${number}`;
    if (id && number) {
      episodes.push({ id, number, title });
    }
  });

  return episodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
}

export async function decryptToken(enc: string): Promise<string> {
  try {
    const base64 = enc.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const fullBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
    const raw = atob(fullBase64);
    const encryptedBuf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      encryptedBuf[i] = raw.charCodeAt(i);
    }

    const keyStr = "i?LMTAx0Q6,:}50U";
    const keyBuf = new Uint8Array(32);
    for (let i = 0; i < Math.min(32, keyStr.length); i++) {
      keyBuf[i] = keyStr.charCodeAt(i);
    }

    const ivStr = "W0;27ToaUpl_P%'c";
    const ivBuf = new Uint8Array(ivStr.length);
    for (let i = 0; i < ivStr.length; i++) {
      ivBuf[i] = ivStr.charCodeAt(i);
    }

    const cryptoObj = typeof window !== 'undefined' && window.crypto ? window.crypto : (globalThis as any).crypto;
    const key = await cryptoObj.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    const decryptedBuf = await cryptoObj.subtle.decrypt({ name: 'AES-CBC', iv: ivBuf }, key, encryptedBuf);
    return new TextDecoder().decode(decryptedBuf);
  } catch (err) {
    console.error("[aniCliCore] decryptToken error:", err);
    return "";
  }
}

// Fetch servers and resolve stream
export async function getEpisodeStream(
  animeTitleOrId: string, 
  episodeIdOrNumber: string = '1',
  mode: 'sub' | 'dub' = 'sub',
  animeId?: string
): Promise<StreamSource> {
  // 1. First priority: Invoke real ani-cli bridge (when running in Vite dev mode).
  if (!Capacitor.isNativePlatform()) {
    try {
      const cleanQuery = (animeId || animeTitleOrId).replace(/-[0-9]+$/, '').replace(/-/g, ' ');
      const epNum = episodeIdOrNumber.replace(/^.*-ep-/, '').replace(/[^0-9.]/g, '') || '1';
      const bridgeUrl = `/api/ani-cli/stream?query=${encodeURIComponent(cleanQuery)}&ep=${encodeURIComponent(epNum)}&mode=${mode}`;
      console.log("[aniCliCore] Requesting stream from bridge:", bridgeUrl);
      const res = await fetchTimed(bridgeUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.streamUrl) {
          console.log("[aniCliCore] Received stream from bridge successfully:", data);
          return {
            streamUrl: data.streamUrl,
            quality: data.qualities?.[0]?.quality || "1080p",
            subtitles: parseSubtitleTracks(data.subtitles),
            referer: data.referer || 'https://hianime.at/',
            masterUrl: data.streamUrl,
            qualities: data.qualities || [{ quality: "1080p", url: data.streamUrl }],
            intro: parseSkipRange(data.intro),
            outro: parseSkipRange(data.outro)
          };
        }
      }
    } catch (err) {
      console.warn("[aniCliCore] bridge call failed, falling back to direct scraper:", err);
    }
  }

  // 2. Secondary fallback (and primary path on Capacitor Native App): direct scrape
  try {
    let targetEpisodeId = episodeIdOrNumber;
    // Resolve targetEpisodeId if needed (e.g. if it is an episode number like '1' rather than an episode data-id)
    let numericAnimeId = (animeId || animeTitleOrId).includes("-") ? (animeId || animeTitleOrId).split("-").pop() : "";
    if (!numericAnimeId || !/^\d+$/.test(numericAnimeId)) {
      const found = await searchAnime(animeTitleOrId);
      if (found.length > 0) {
        numericAnimeId = found[0].id.split("-").pop() || "";
      }
    }
    if (numericAnimeId && /^\d+$/.test(numericAnimeId)) {
      const list = await getEpisodes(numericAnimeId);
      const epNum = episodeIdOrNumber.replace(/^.*-ep-/, '').replace(/[^0-9.]/g, '') || '1';
      // Match by exact episode ID first; if none matches (e.g. targetEpisodeId was '1'), match by episode number
      const match = list.find(e => e.id === targetEpisodeId) || list.find(e => e.number === epNum || e.number === episodeIdOrNumber || e.id === episodeIdOrNumber);
      if (match && match.id) {
        targetEpisodeId = match.id;
      }
    }

    const endpoint = `${getApiBase()}/api/theme/episode/servers?episodeId=${targetEpisodeId}`;
    const res = await fetchWithRetry(endpoint, { headers: UPSTREAM_HEADERS });
    if (!res.ok) {
      throw new Error(`servers endpoint returned HTTP ${res.status} for episodeId=${targetEpisodeId}`);
    }
    const data = await res.json();

    if (data.html) {
      const hashes = pickServerHashes(data.html, mode);
      if (hashes.length === 0) {
        console.warn("[aniCliCore] Direct scrape: no server entry found in servers HTML for mode", mode);
      }
      // Every server of the requested audio type, hedged: see
      // resolveFirstServer.
      const source = await resolveFirstServer(hashes, targetEpisodeId, mode);
      if (source) return source;
    } else {
      console.warn("[aniCliCore] Direct scrape: servers endpoint response had no 'html' field", data);
    }
  } catch (err) {
    console.warn("[aniCliCore] Direct scrape threw:", err);
  }

  // Every real source failed. Never substitute other content (the old demo
  // clip) - the caller shows an error with Retry instead.
  console.error(`[aniCliCore] All stream sources failed for "${animeTitleOrId}" ep ${episodeIdOrNumber} (${mode})`);
  throw new SourceUnavailableError(`No ${mode} server could play episode ${episodeIdOrNumber}`);
}

// Thrown when no server can serve an episode right now.
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

// If the server being tried hasn't produced a stream after this long, the
// next one is started alongside it.
const HEDGE_DELAY_MS = 2500;

// Resolves the first server (of `hashes`, in the site's preference order)
// that yields a playable stream. Servers aren't tried strictly one after
// another: a slow or hanging mirror would hold playback for its full
// timeouts (2 x 15 s) before the next was even asked. Instead each server
// gets a HEDGE_DELAY_MS head start, then the next starts in parallel; a
// server that fails outright hands over immediately. A fast first server
// behaves exactly like the sequential walk.
export function resolveFirstServer(
  hashes: string[],
  episodeId: string,
  mode: 'sub' | 'dub',
  resolve: (hash: string, episodeId: string, mode: 'sub' | 'dub') => Promise<StreamSource | null> = resolveEmbed,
  hedgeDelayMs = HEDGE_DELAY_MS
): Promise<StreamSource | null> {
  return new Promise(done => {
    let next = 0;
    let pending = 0;
    let finished = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (source: StreamSource | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      done(source);
    };

    const launch = () => {
      if (finished || next >= hashes.length) return;
      const hash = hashes[next++];
      pending++;
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, hedgeDelayMs);
      resolve(hash, episodeId, mode)
        .then(source => { if (source) finish(source); })
        .catch(err => console.warn(`[aniCliCore] episodeId=${episodeId} server failed:`, err))
        .finally(() => {
          pending--;
          if (finished) return;
          if (next < hashes.length) launch();
          else if (pending === 0) finish(null);
        });
    };

    if (hashes.length === 0) finish(null);
    else launch();
  });
}

// Server hashes to try, best first: every server tagged with the requested
// audio type, or - only when the episode has none of that type at all -
// whatever servers exist (better than nothing; the player labels the mode).
function pickServerHashes(serversHtml: string, mode: 'sub' | 'dub'): string[] {
  const doc = new DOMParser().parseFromString(serversHtml, "text/html");
  const hashesOf = (selector: string) => Array.from(doc.querySelectorAll(selector))
    .map(el => el.getAttribute("data-hash") || "")
    .filter(Boolean);
  const preferred = hashesOf(`[data-type="${mode}"][data-hash]`);
  // Prefer the requested audio mode; fall back to available servers if requested mode has none
  const list = preferred.length > 0 ? preferred : hashesOf("[data-hash]");
  return Array.from(new Set(list)).slice(0, 4);
}

function decodeEmbedUrl(hash: string): string | null {
  try {
    const url = new URL(atob(hash));
    // The hash comes from a third-party page - never follow it to anything
    // but a plain web URL (no javascript:, file:, content:, ...).
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Subtitle tracks from a sources payload. Players also list a "thumbnails"
// sprite VTT in the same array, which must never show up as a caption.
function parseSubtitleTracks(tracks: any): SubtitleTrack[] {
  if (!Array.isArray(tracks)) return [];
  const seen = new Set<string>();
  const out: SubtitleTrack[] = [];
  for (const t of tracks) {
    const src = t?.file || t?.src;
    const kind = String(t?.kind || "captions").toLowerCase();
    if (!src || typeof src !== "string" || (kind !== "captions" && kind !== "subtitles")) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({ src, label: t.label || t.lang || "English", default: t.default === true });
  }
  return out;
}

// Resolves one server entry (base64 embed URL) to a playable stream, or
// null when that server doesn't yield one.
async function resolveEmbed(hash: string, episodeId: string, mode: 'sub' | 'dub'): Promise<StreamSource | null> {
  const embedUrl = decodeEmbedUrl(hash);
  if (!embedUrl) return null;
  console.log(`[aniCliCore] episodeId=${episodeId} mode=${mode} resolved embedUrl:`, embedUrl);
  const embedRes = await fetchTimed(embedUrl, {
    headers: {
      ...UPSTREAM_HEADERS,
      'Referer': `${REMOTE_HOST}/`
    }
  });
  if (!embedRes.ok) return null;
  const embedHtml = await embedRes.text();
  const embedOrigin = new URL(embedUrl).origin;

  // Current embeds carry the whole payload inline (window.__P, XOR-obfuscated);
  // older ones expose a sources endpoint keyed by a data-id.
  const inline = parseEmbedPayload(embedHtml);
  if (inline) {
    const src = typeof inline.src === 'string' ? inline.src : '';
    if (!src) return null;
    return sourceFrom(
      src,
      embedOrigin,
      (Array.isArray(inline.subtitles) ? inline.subtitles : []).map((t: any) => ({ ...t, file: t.src, kind: 'captions' })),
      parseSkipRange(inline.skip?.intro),
      parseSkipRange(inline.skip?.outro),
      typeof inline.sprite_vtt === 'string' ? inline.sprite_vtt : undefined
    );
  }

  const idMatch = embedHtml.match(/data-id="(\d+)"/i);
  if (!idMatch) return null;

  const sourcesUrl = `${embedOrigin}/stream/getSourcesNew?id=${idMatch[1]}`;
  const sourcesRes = await fetchTimed(sourcesUrl, {
    headers: {
      ...UPSTREAM_HEADERS,
      'Referer': embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  if (!sourcesRes.ok) return null;
  const sourcesJson = await sourcesRes.json();

  let rawStreamUrl = "";
  let intro = parseSkipRange(sourcesJson.intro);
  let outro = parseSkipRange(sourcesJson.outro);
  let tracks = sourcesJson.tracks;
  if (sourcesJson.sources && sourcesJson.sources[0]?.file) {
    rawStreamUrl = sourcesJson.sources[0].file;
  } else if (sourcesJson.enc) {
    const decStr = await decryptToken(sourcesJson.enc);
    if (decStr) {
      try {
        const dec = JSON.parse(decStr);
        rawStreamUrl = dec.file || dec.src;
        intro = intro || parseSkipRange(dec.intro);
        outro = outro || parseSkipRange(dec.outro);
        tracks = tracks || dec.tracks;
      } catch (e) {
        console.error("[aniCliCore] JSON parse error on decrypted token:", e);
      }
    }
  }
  if (!rawStreamUrl || typeof rawStreamUrl !== "string") return null;

  console.log(`[aniCliCore] episodeId=${episodeId} mode=${mode} RESOLVED STREAM URL:`, rawStreamUrl);
  console.log(`[aniCliCore] episodeId=${episodeId} skip markers: intro=`, intro, 'outro=', outro);

  return sourceFrom(rawStreamUrl, embedOrigin, tracks, intro, outro, findSpriteVtt(tracks));
}

function safeAtob(b64: string): string {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = clean.length % 4;
  const padded = pad ? clean + '='.repeat(4 - pad) : clean;
  return atob(padded);
}

// The inline payload of current embeds: base64 of JSON, XOR-ed with a fixed key.
export function parseEmbedPayload(html: string): any | null {
  const match = html.match(/window\.__P\s*=\s*"([^"]+)"/);
  if (!match) return null;
  try {
    const raw = safeAtob(match[1]);
    const key = "otaku-embed-v1";
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    console.warn("[aniCliCore] embed payload could not be decoded:", err);
    return null;
  }
}

// The thumbnails sprite VTT listed among a sources payload's tracks.
function findSpriteVtt(tracks: any): string | undefined {
  if (!Array.isArray(tracks)) return undefined;
  const t = tracks.find((x: any) => String(x?.kind || '').toLowerCase() === 'thumbnails' && (x?.file || x?.src));
  return t ? String(t.file || t.src) : undefined;
}

function sourceFrom(
  rawStreamUrl: string,
  embedOrigin: string,
  tracks: any,
  intro: SkipRange | undefined,
  outro: SkipRange | undefined,
  spriteVtt: string | undefined
): StreamSource {
  const subtitles = parseSubtitleTracks(tracks);
  return {
    streamUrl: rawStreamUrl,
    quality: "1080p",
    subtitles,
    referer: embedOrigin + '/',
    spriteVtt,
    masterUrl: rawStreamUrl,
    // One adaptive (HLS master) URL - the players pick the rendition. The
    // labels only exist so the "Default Quality" preference has something
    // to match; the menus hide them because the URLs are identical.
    qualities: [
      { quality: "1080p", url: rawStreamUrl },
      { quality: "720p", url: rawStreamUrl },
      { quality: "480p", url: rawStreamUrl },
      { quality: "Auto", url: rawStreamUrl }
    ],
    intro,
    outro
  };
}
