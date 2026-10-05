// aniCliCore.ts - Port of ani-cli scraping & deobfuscation logic
import { Capacitor } from '@capacitor/core';
import { getJson, getText, HttpError } from './http';

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
  // Legacy flag from when a demo clip stood in for failed sources. Stream
  // resolution now throws instead, so this is never set; kept so the native
  // bridge contract doesn't change.
  isFallback?: boolean;
  // Opening/ending intervals served by the embed player's own sources
  // endpoint (the same data HiAnime's "Skip Intro"/"Skip Outro" uses).
  // Absent when the server didn't tag this episode.
  intro?: SkipRange;
  outro?: SkipRange;
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

// Headers the dev proxy injects automatically; native requests need them set explicitly.
const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': `${REMOTE_HOST}/`
};

// Listing/detail pages change slowly - reusing them for a few minutes makes
// back-navigation and repeat visits instant and keeps load off the site.
const PAGE_TTL_MS = 5 * 60 * 1000;
const EPISODE_LIST_TTL_MS = 10 * 60 * 1000;

// Thrown when a title/episode genuinely can't be served right now, so the UI
// can show an honest error with a retry instead of fake content.
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

// Fetches a page of the streaming site as HTML. `path` may be a site path
// ("/genre/action") or an absolute URL on the site.
export function fetchSiteHtml(path: string, ttlMs = PAGE_TTL_MS): Promise<string> {
  const sitePath = path.startsWith('http') ? new URL(path).pathname + new URL(path).search : path;
  return getText(`${getApiBase()}${sitePath}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      ...UPSTREAM_HEADERS
    }
  }, { ttlMs });
}

// Live search. Throws on network failure - callers show an error + retry.
export async function searchAnimeLive(query: string): Promise<AnimeItem[]> {
  const html = await fetchSiteHtml(`/search?keyword=${encodeURIComponent(query)}`);
  return parseSearchResults(html);
}

export async function searchAnime(query: string): Promise<AnimeItem[]> {
  if (!query.trim()) return [];
  return searchAnimeLive(query);
}

// Trending/homepage anime (same card markup as search results).
// The root "/" is just a landing page - /home is the actual suggestions feed.
// Throws when the feed can't be loaded so the home screen can offer a retry.
export async function getTrendingAnime(): Promise<AnimeItem[]> {
  const results = parseSearchResults(await fetchSiteHtml('/home'));
  if (results.length === 0) {
    throw new SourceUnavailableError('The home feed came back empty');
  }
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
    const title = titleEl.getAttribute("title") || titleEl.textContent?.trim() || "";
    const poster = posterEl?.getAttribute("data-src") || posterEl?.getAttribute("src") || "";

    // Some pages mix in non-anime cards (ad slots, "load more" tiles, slider
    // clones used for seamless looping) alongside real ones with the same
    // .film-detail markup - drop anything missing the essentials or that
    // isn't a real, distinct entry rather than surfacing it as junk.
    const isValid = slug.length > 0 && title.length > 1 && (poster.startsWith("http") || poster.startsWith("//"));
    if (!isValid || seenIds.has(slug)) return;
    seenIds.add(slug);

    const subBadge = el.querySelector(".tick-sub")?.textContent?.trim();
    const dubBadge = el.querySelector(".tick-dub")?.textContent?.trim();
    const epBadge = el.querySelector(".tick-eps")?.textContent?.trim();

    results.push({
      id: slug,
      title,
      poster,
      path,
      type: parseTypeBadge(el),
      subCount: subBadge ? parseInt(subBadge, 10) : (epBadge ? parseInt(epBadge, 10) : undefined),
      dubCount: dubBadge ? parseInt(dubBadge, 10) : undefined
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

// Trailing numeric id of a site slug: "one-piece-100" -> "100".
function numericIdOf(slugOrId: string): string {
  const last = slugOrId.split("-").pop() || "";
  return /^\d+$/.test(last) ? last : "";
}

// Slug without its numeric id: "one-piece-100" -> "one-piece".
function slugBaseOf(slug: string): string {
  return slug.replace(/-\d+$/, '');
}

function episodeListUrl(numericId: string): string {
  return `${getApiBase()}/api/theme/episode/list/${numericId}`;
}

function parseEpisodeList(html: string): EpisodeItem[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const episodes: EpisodeItem[] = [];
  doc.querySelectorAll(".ep-item").forEach((ep) => {
    const id = ep.getAttribute("data-id") || "";
    const number = ep.getAttribute("data-number") || "";
    const title = ep.getAttribute("title") || `Episode ${number}`;
    if (id && number) episodes.push({ id, number, title });
  });
  return episodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
}

async function fetchEpisodeList(numericId: string): Promise<EpisodeItem[]> {
  const data = await getJson<{ html?: string }>(episodeListUrl(numericId), { headers: UPSTREAM_HEADERS }, {
    ttlMs: EPISODE_LIST_TTL_MS
  });
  return data?.html ? parseEpisodeList(data.html) : [];
}

// Real episode list, sorted by episode number. Throws when it can't be
// loaded - never invents episodes that would only ever play the wrong thing.
export async function getEpisodes(animeId: string): Promise<EpisodeItem[]> {
  const numericId = numericIdOf(animeId);
  if (numericId) {
    try {
      return await fetchEpisodeList(numericId);
    } catch (err) {
      // A 404 usually means the site re-numbered the title; anything else
      // (network down, timeout) is worth surfacing as-is.
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
      console.warn(`[aniCliCore] Episode list for ${animeId} returned 404, re-resolving by slug`);
    }
  }

  // Re-find the title by name and only accept the very same slug, so a
  // stale id can never silently resolve to a different show.
  const base = slugBaseOf(animeId);
  const found = await searchAnimeLive(base.replace(/-/g, ' '));
  const same = found.find(r => slugBaseOf(r.id) === base && numericIdOf(r.id) && numericIdOf(r.id) !== numericId);
  if (!same) throw new SourceUnavailableError(`No episode list found for "${animeId}"`);
  return fetchEpisodeList(numericIdOf(same.id));
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

// ----------------------------------------------------------- stream resolution

// Resolved stream URLs carry short-lived CDN tokens, so they're only reused
// briefly - long enough for a sub/dub flip back, a retry, or a next-episode
// prefetch made near the end of the current one.
const STREAM_TTL_MS = 8 * 60 * 1000;

interface CachedStream {
  source: Promise<StreamSource>;
  expires: number;
}

const streamCache = new Map<string, CachedStream>();

function streamKey(episodeKey: string, mode: string): string {
  return `${episodeKey}|${mode}`;
}

interface ServerEntry {
  hash: string;
  type: string;
  name: string;
}

function parseServers(html: string): ServerEntry[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll('[data-hash]')).map(el => ({
    hash: el.getAttribute('data-hash') || '',
    type: (el.getAttribute('data-type') || '').toLowerCase(),
    name: (el.textContent || '').trim()
  })).filter(s => s.hash);
}

// Servers to try, best first: every server of the requested audio mode in
// the site's own order, and only when that mode has none at all, whatever
// else exists (some titles list a single untyped/raw server).
export function orderServers<T extends { type: string }>(servers: T[], mode: 'sub' | 'dub'): T[] {
  const matching = servers.filter(s => s.type === mode);
  return matching.length > 0 ? matching : servers;
}

// Turns a non-numeric episode reference (legacy "<slug>-ep-<n>" ids from
// older history entries) into the site's numeric episode id.
async function resolveEpisodeId(animeTitleOrId: string, episodeIdOrNumber: string, animeId?: string): Promise<string> {
  if (/^\d+$/.test(episodeIdOrNumber)) return episodeIdOrNumber;
  const list = await getEpisodes(animeId || animeTitleOrId);
  const epNum = episodeIdOrNumber.replace(/^.*-ep-/, '').replace(/[^0-9.]/g, '') || '1';
  const match = list.find(e => e.number === epNum || e.id === episodeIdOrNumber);
  if (!match) throw new SourceUnavailableError(`Episode ${epNum} was not found`);
  return match.id;
}

// One embed server -> playable stream. Throws if this server can't serve it.
async function resolveFromServer(server: ServerEntry): Promise<StreamSource> {
  const embedUrl = atob(server.hash);
  const embedHtml = await getText(embedUrl, {
    headers: { ...UPSTREAM_HEADERS, 'Referer': `${REMOTE_HOST}/` }
  }, { retries: 1 });
  const idMatch = embedHtml.match(/data-id="(\d+)"/i);
  if (!idMatch) throw new Error(`embed page had no data-id: ${embedUrl}`);

  const embedOrigin = new URL(embedUrl).origin;
  const sourcesJson = await getJson(`${embedOrigin}/stream/getSourcesNew?id=${idMatch[1]}`, {
    headers: {
      ...UPSTREAM_HEADERS,
      'Referer': embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  }, { retries: 1 });

  let rawStreamUrl = "";
  let intro = parseSkipRange(sourcesJson?.intro);
  let outro = parseSkipRange(sourcesJson?.outro);
  if (sourcesJson?.sources?.[0]?.file) {
    rawStreamUrl = sourcesJson.sources[0].file;
  } else if (sourcesJson?.enc) {
    const decStr = await decryptToken(sourcesJson.enc);
    if (decStr) {
      const dec = JSON.parse(decStr);
      rawStreamUrl = dec.file || dec.src || "";
      intro = intro || parseSkipRange(dec.intro);
      outro = outro || parseSkipRange(dec.outro);
    }
  }
  if (!rawStreamUrl) throw new Error(`sources payload had no stream URL (${embedOrigin})`);

  const subtitles: SubtitleTrack[] = (sourcesJson.tracks || [])
    .filter((t: any) => (t.kind === 'captions' || t.kind === 'subtitles' || !t.kind) && (t.file || t.src))
    .map((s: any) => ({
      src: s.file || s.src,
      label: s.label || s.lang || "English",
      default: s.default === true
    }));

  // One adaptive (HLS master) URL - the players expose its real renditions.
  // Listing fake "1080p/720p/480p" entries that all point at the same URL
  // would only make the quality menu lie.
  return {
    streamUrl: rawStreamUrl,
    quality: "Auto",
    subtitles,
    referer: embedOrigin + '/',
    masterUrl: rawStreamUrl,
    qualities: [{ quality: "Auto", url: rawStreamUrl }],
    intro,
    outro
  };
}

async function resolveViaDevBridge(animeTitleOrId: string, episodeIdOrNumber: string, mode: 'sub' | 'dub', animeId?: string): Promise<StreamSource | null> {
  try {
    const cleanQuery = (animeId || animeTitleOrId).replace(/-[0-9]+$/, '').replace(/-/g, ' ');
    const epNum = episodeIdOrNumber.replace(/^.*-ep-/, '').replace(/[^0-9.]/g, '') || '1';
    const bridgeUrl = `/api/ani-cli/stream?query=${encodeURIComponent(cleanQuery)}&ep=${encodeURIComponent(epNum)}&mode=${mode}`;
    const data = await getJson(bridgeUrl, undefined, { retries: 0 });
    if (!data?.streamUrl) return null;
    return {
      streamUrl: data.streamUrl,
      quality: data.qualities?.[0]?.quality || "Auto",
      subtitles: data.subtitles || [],
      referer: data.referer || 'https://hianime.at/',
      masterUrl: data.streamUrl,
      qualities: data.qualities || [{ quality: "Auto", url: data.streamUrl }],
      intro: parseSkipRange(data.intro),
      outro: parseSkipRange(data.outro)
    };
  } catch (err) {
    console.warn("[aniCliCore] dev bridge unavailable, using direct scraper:", err);
    return null;
  }
}

async function resolveStream(
  animeTitleOrId: string,
  episodeIdOrNumber: string,
  mode: 'sub' | 'dub',
  animeId?: string
): Promise<StreamSource> {
  // Dev only: the real ani-cli bridge served by the Vite plugin.
  if (!Capacitor.isNativePlatform()) {
    const bridged = await resolveViaDevBridge(animeTitleOrId, episodeIdOrNumber, mode, animeId);
    if (bridged) return bridged;
  }

  const episodeId = await resolveEpisodeId(animeTitleOrId, episodeIdOrNumber, animeId);
  const data = await getJson<{ html?: string }>(
    `${getApiBase()}/api/theme/episode/servers?episodeId=${episodeId}`,
    { headers: UPSTREAM_HEADERS }
  );
  const servers = orderServers(parseServers(data?.html || ''), mode);
  if (servers.length === 0) {
    throw new SourceUnavailableError(`No ${mode} servers are listed for this episode`);
  }

  // Mirrors go down independently - walk the list instead of giving up when
  // the first one fails.
  const failures: string[] = [];
  for (const server of servers) {
    try {
      const source = await resolveFromServer(server);
      console.log(`[aniCliCore] episodeId=${episodeId} mode=${mode} resolved via "${server.name || server.type}"`);
      return source;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${server.name || server.type}: ${reason}`);
      console.warn(`[aniCliCore] server "${server.name || server.type}" failed for episodeId=${episodeId}:`, err);
    }
  }
  throw new SourceUnavailableError(`All ${servers.length} ${mode} server(s) failed - ${failures.join('; ')}`);
}

// Resolves a playable stream for an episode, trying every available server.
// Concurrent and repeated requests for the same episode share one result for
// a few minutes; pass forceRefresh to bypass that (e.g. the CDN link expired).
// Throws when no server can serve it - never substitutes other content.
export function getEpisodeStream(
  animeTitleOrId: string,
  episodeIdOrNumber: string = '1',
  mode: 'sub' | 'dub' = 'sub',
  animeId?: string,
  forceRefresh = false
): Promise<StreamSource> {
  const key = streamKey(`${animeId || animeTitleOrId}:${episodeIdOrNumber}`, mode);
  const cached = streamCache.get(key);
  if (!forceRefresh && cached && cached.expires > Date.now()) {
    // Hand out copies: callers adjust fields (e.g. chosen quality).
    return cached.source.then(s => ({ ...s }));
  }

  const source = resolveStream(animeTitleOrId, episodeIdOrNumber, mode, animeId);
  const entry = { source, expires: Date.now() + STREAM_TTL_MS };
  streamCache.set(key, entry);
  source.catch(() => {
    if (streamCache.get(key) === entry) streamCache.delete(key);
  });
  // Bound the cache: expired entries are useless, drop them as we go.
  for (const [k, v] of streamCache) {
    if (v.expires <= Date.now()) streamCache.delete(k);
  }
  return source.then(s => ({ ...s }));
}

// Warms the stream cache for an episode the user is likely to play next, so
// "Next Episode" starts without the resolution wait. Failures are ignored -
// the real request will retry and report them.
export function prefetchEpisodeStream(
  animeTitleOrId: string,
  episodeIdOrNumber: string,
  mode: 'sub' | 'dub',
  animeId?: string
): void {
  getEpisodeStream(animeTitleOrId, episodeIdOrNumber, mode, animeId).catch(() => undefined);
}
