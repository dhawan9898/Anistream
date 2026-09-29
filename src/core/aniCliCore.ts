// aniCliCore.ts - Port of ani-cli scraping & deobfuscation logic
import { Capacitor } from '@capacitor/core';

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

// Every network step of stream resolution goes through this so one hung
// request can't leave the player spinning forever. The timeout is enforced
// with Promise.race because the native (CapacitorHttp) fetch ignores
// signals; on the web the AbortController additionally cancels the
// underlying request so a timed-out download doesn't keep eating bandwidth.
const FETCH_TIMEOUT_MS = 15000;

function fetchTimed(input: string, init?: RequestInit, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`request timed out after ${ms}ms: ${input}`));
    }, ms);
  });
  return Promise.race([fetch(input, { ...init, signal: controller?.signal }), timeout])
    .finally(() => clearTimeout(timer));
}

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
const CACHE_MAX_ENTRIES = 200;

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
  return cached(`html:${sitePath}`, PAGE_TTL_MS, async () => {
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
  });
}

// Live search only - no curated/mock fallback. Throws on network failure.
export async function searchAnimeLive(query: string): Promise<AnimeItem[]> {
  const html = await fetchSiteHtml(`/search?keyword=${encodeURIComponent(query)}`);
  return parseSearchResults(html);
}

// Search anime
export async function searchAnime(query: string): Promise<AnimeItem[]> {
  if (!query.trim()) return FEATURED_ANIME;

  try {
    return await searchAnimeLive(query);
  } catch (err) {
    console.warn("Live search failed, returning curated results:", err);
    return filterMockAnime(query);
  }
}

// Trending/homepage anime (same card markup as search results).
// The root "/" is just a landing page - /home is the actual suggestions feed.
export async function getTrendingAnime(): Promise<AnimeItem[]> {
  try {
    // Same cached request the genre menu (catalogService.getGenres) uses.
    const html = await fetchSiteHtml('/home');
    const results = parseSearchResults(html);
    return results.length > 0 ? results : FEATURED_ANIME;
  } catch (err) {
    console.warn("Live homepage fetch failed, using curated fallback:", err);
    return FEATURED_ANIME;
  }
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

// Fetch episodes list. Cached per anime: the detail page and the player
// both need it, and re-opening a title shouldn't refetch it.
export function getEpisodes(animeId: string): Promise<EpisodeItem[]> {
  return cached(`episodes:${animeId}`, EPISODE_LIST_TTL_MS, () => loadEpisodes(animeId))
    .then(list => {
      // A generated placeholder list means the real fetch failed - don't
      // keep serving it from cache; let the next visit try again.
      if (list.length > 0 && list[0].id.includes('-ep-')) responseCache.delete(`episodes:${animeId}`);
      return list;
    });
}

async function loadEpisodes(animeId: string): Promise<EpisodeItem[]> {
  try {
    let numericId = animeId.includes("-") ? animeId.split("-").pop() : animeId;
    let endpoint = `${getApiBase()}/api/theme/episode/list/${numericId}`;
    let res = await fetchWithRetry(endpoint, { headers: UPSTREAM_HEADERS });

    if (!res.ok) {
      const cleanTitle = animeId.replace(/-[0-9]+$/, '').replace(/-/g, ' ');
      if (cleanTitle) {
        const found = await searchAnime(cleanTitle);
        if (found.length > 0 && found[0].id) {
          const newNumericId = found[0].id.split("-").pop();
          if (newNumericId && newNumericId !== numericId) {
            endpoint = `${getApiBase()}/api/theme/episode/list/${newNumericId}`;
            res = await fetchTimed(endpoint, { headers: UPSTREAM_HEADERS });
          }
        }
      }
    }

    if (!res.ok) {
      throw new Error(`Episodes fetch failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.html) return generateFallbackEpisodes(animeId);

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

    return episodes.length > 0 ? episodes : generateFallbackEpisodes(animeId);
  } catch (err) {
    console.warn("Episode list fetch failed, generating fallback episodes:", err);
    return generateFallbackEpisodes(animeId);
  }
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
  animeId?: string,
  options: StreamLookupOptions = {}
): Promise<StreamSource> {
  const exclude = new Set(options.excludeStreamUrls || []);
  // 1. First priority: Invoke real ani-cli bridge (when running in Vite dev
  // mode). It always returns the same server, so it's skipped when looking
  // for an alternative to a stream that already failed.
  if (!Capacitor.isNativePlatform() && exclude.size === 0) {
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
    // If targetEpisodeId is not a numeric episode ID, resolve from anime episode list
    if (!/^\d+$/.test(targetEpisodeId)) {
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
        // No match means no such episode - never silently play episode 1 instead.
        const match = list.find(e => e.number === epNum || e.id === episodeIdOrNumber);
        if (match && match.id) {
          targetEpisodeId = match.id;
        }
      }
    }

    const endpoint = `${getApiBase()}/api/theme/episode/servers?episodeId=${targetEpisodeId}`;
    const res = await fetchWithRetry(endpoint, { headers: UPSTREAM_HEADERS });
    if (!res.ok) {
      console.warn(`[aniCliCore] Direct scrape: servers endpoint returned HTTP ${res.status} for episodeId=${targetEpisodeId}`);
    }
    const data = await res.json();

    if (data.html) {
      const hashes = pickServerHashes(data.html, mode);
      if (hashes.length === 0) {
        console.warn("[aniCliCore] Direct scrape: no server entry found in servers HTML for mode", mode);
      }
      // Try every server of the requested audio type in the site's own
      // order: one dead mirror (403, removed video, broken embed) used to
      // drop straight to the demo clip even when the next server was fine.
      //
      // A server can also resolve fine yet point at a stream whose files are
      // gone (the CDN answers 404 for the playlist or its segments) - so each
      // candidate is probed before it's handed to the player, and streams
      // that already failed in the player (options.excludeStreamUrls) are
      // skipped when looking for a replacement.
      for (const hash of hashes) {
        try {
          const source = await resolveEmbed(hash, targetEpisodeId, mode);
          if (!source) continue;
          if (exclude.has(source.streamUrl)) {
            console.warn(`[aniCliCore] episodeId=${targetEpisodeId} skipping stream that already failed:`, source.streamUrl);
            continue;
          }
          const [verdict, subtitles] = await Promise.all([
            probeStream(source.streamUrl, source.referer),
            dropDeadSubtitles(source.subtitles, source.referer)
          ]);
          if (verdict === 'dead') {
            console.warn(`[aniCliCore] episodeId=${targetEpisodeId} stream is dead on the CDN, trying next server:`, source.streamUrl);
            continue;
          }
          return { ...source, subtitles };
        } catch (err) {
          console.warn(`[aniCliCore] episodeId=${targetEpisodeId} server failed, trying next:`, err);
        }
      }
    } else {
      console.warn("[aniCliCore] Direct scrape: servers endpoint response had no 'html' field", data);
    }
  } catch (err) {
    console.warn("[aniCliCore] Direct scrape threw - falling back to demo stream:", err);
  }

  // Every real source failed.
  console.error(
    `[aniCliCore] All real stream sources failed for "${animeTitleOrId}" ep ${episodeIdOrNumber} (${mode}) - ` +
    `showing a demo stream instead of the real episode. See warnings above for which step failed.`
  );
  return {
    streamUrl: "https://storage.googleapis.com/cloud-samples-data/video/animals.mp4",
    quality: "Demo",
    referer: "https://hianime.at/",
    subtitles: [],
    masterUrl: "https://storage.googleapis.com/cloud-samples-data/video/animals.mp4",
    qualities: [
      { quality: "Demo", url: "https://storage.googleapis.com/cloud-samples-data/video/animals.mp4" }
    ],
    isFallback: true
  };
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
  const idMatch = embedHtml.match(/data-id="(\d+)"/i);
  if (!idMatch) return null;

  const embedOrigin = new URL(embedUrl).origin;
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

  const subtitles = parseSubtitleTracks(tracks);
  console.log(`[aniCliCore] episodeId=${episodeId} mode=${mode} RESOLVED STREAM URL:`, rawStreamUrl);
  console.log(`[aniCliCore] episodeId=${episodeId} skip markers: intro=`, intro, 'outro=', outro);

  return {
    streamUrl: rawStreamUrl,
    quality: "1080p",
    subtitles,
    referer: embedOrigin + '/',
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

export interface StreamLookupOptions {
  // Streams that already failed in the player - never hand these back.
  excludeStreamUrls?: string[];
}

// Same identity the players present to the CDN (ExoPlayer sends exactly
// these two headers), so a probe sees what playback would see.
function cdnHeaders(referer: string): Record<string, string> {
  return {
    'User-Agent': UPSTREAM_HEADERS['User-Agent'],
    'Referer': referer
  };
}

const PROBE_TIMEOUT_MS = 8000;

// A 4xx from the CDN (except 429) means the file isn't there for us and a
// player would fail the same way; 5xx/429/network errors may be transient.
function isDeadStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

function firstPlaylistUri(playlist: string): string | null {
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return null;
}

// Checks that an HLS stream is really playable: master playlist -> first
// variant playlist -> first segment. 'dead' only on definite evidence (a 4xx
// or a body that isn't a playlist); anything inconclusive is 'unknown' and
// the stream is still used. Native only: in a browser the CDN's CORS rules
// and the forbidden Referer header make a probe meaningless.
export async function probeStream(url: string, referer: string): Promise<'ok' | 'dead' | 'unknown'> {
  if (!Capacitor.isNativePlatform()) return 'unknown';
  if (url.toLowerCase().split('?')[0].endsWith('.mp4')) return 'unknown';
  const headers = cdnHeaders(referer);
  try {
    const master = await fetchTimed(url, { headers }, PROBE_TIMEOUT_MS);
    if (!master.ok) return isDeadStatus(master.status) ? 'dead' : 'unknown';
    let playlist = await master.text();
    if (!playlist.trimStart().startsWith('#EXTM3U')) return 'dead';
    let playlistUrl = url;

    if (/#EXT-X-STREAM-INF/i.test(playlist)) {
      const variant = firstPlaylistUri(playlist);
      if (!variant) return 'dead';
      playlistUrl = new URL(variant, url).toString();
      const res = await fetchTimed(playlistUrl, { headers }, PROBE_TIMEOUT_MS);
      if (!res.ok) return isDeadStatus(res.status) ? 'dead' : 'unknown';
      playlist = await res.text();
      if (!playlist.trimStart().startsWith('#EXTM3U')) return 'dead';
    }

    const segment = firstPlaylistUri(playlist);
    if (!segment) return 'dead';
    const segRes = await fetchTimed(new URL(segment, playlistUrl).toString(), {
      headers: { ...headers, 'Range': 'bytes=0-1023' }
    }, PROBE_TIMEOUT_MS);
    if (!segRes.ok) return isDeadStatus(segRes.status) ? 'dead' : 'unknown';
    return 'ok';
  } catch (err) {
    console.warn('[aniCliCore] stream probe inconclusive:', err);
    return 'unknown';
  }
}

// ExoPlayer treats a side-loaded subtitle that fails to load as a fatal
// playback error (a browser just ignores it), so on native, subtitle files
// the CDN definitely doesn't have are dropped before playback.
async function dropDeadSubtitles(tracks: SubtitleTrack[], referer: string): Promise<SubtitleTrack[]> {
  if (!Capacitor.isNativePlatform() || tracks.length === 0) return tracks;
  const checks = await Promise.all(tracks.map(async track => {
    try {
      const res = await fetchTimed(track.src, {
        headers: { ...cdnHeaders(referer), 'Range': 'bytes=0-511' }
      }, PROBE_TIMEOUT_MS);
      return !isDeadStatus(res.status);
    } catch {
      return true; // inconclusive - keep it
    }
  }));
  const kept = tracks.filter((_, i) => checks[i]);
  if (kept.length !== tracks.length) {
    console.warn('[aniCliCore] dropped subtitle tracks that return 4xx:', tracks.filter((_, i) => !checks[i]).map(t => t.label));
  }
  return kept;
}

// Fallback episode generator
function generateFallbackEpisodes(animeId: string): EpisodeItem[] {
  const count = animeId.includes("one-piece") ? 24 : 12;
  const list: EpisodeItem[] = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      id: `${animeId}-ep-${i}`,
      number: String(i),
      title: `Episode ${i}`
    });
  }
  return list;
}

// Curated featured & trending anime showcase
export const FEATURED_ANIME: AnimeItem[] = [
  {
    id: "solo-leveling-season-2-arise-from-the-shadow-84",
    title: "Solo Leveling: Arise from the Shadow",
    poster: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 13,
    dubCount: 13,
    description: "Ten years ago, 'the Gate' appeared and connected the real world with the realm of magic and monsters. Jinwoo Sung transforms into humanity's greatest shadow monarch."
  },
  {
    id: "jujutsu-kaisen-season-2-415",
    title: "Jujutsu Kaisen: Shibuya Incident",
    poster: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 23,
    dubCount: 23,
    description: "Halloween in Shibuya. A curtain suddenly falls over the district, trapping countless civilians as special grade curses execute their devastating plan."
  },
  {
    id: "demon-slayer-kimetsu-no-yaiba-hashira-training-arc-430",
    title: "Demon Slayer: Hashira Training Arc",
    poster: "https://images.unsplash.com/photo-1563089145-599997674d42?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 8,
    dubCount: 8,
    description: "Tanjiro visits the Stone Hashira, Himejima, who intends to prepare him for the battles to come. Training to become a Hashira is rigorous and demanding."
  },
  {
    id: "one-piece-1",
    title: "One Piece",
    poster: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 1120,
    dubCount: 1080,
    description: "Luffy and the Straw Hat Pirates embark on an epic voyage across the Grand Line in search of the legendary treasure known as One Piece."
  },
  {
    id: "frieren-beyond-journeys-end-481",
    title: "Frieren: Beyond Journey's End",
    poster: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 28,
    dubCount: 28,
    description: "After defeating the Demon King, the elven mage Frieren embarks on a nostalgic quest across the continent to understand humanity and honor past friendships."
  },
  {
    id: "cyberpunk-edgerunners-1048",
    title: "Cyberpunk: Edgerunners",
    poster: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1200&auto=format&fit=crop",
    type: "ONA",
    subCount: 10,
    dubCount: 10,
    description: "A street kid trying to survive in a technology and body modification-obsessed city of the future chooses to stay alive by becoming an edgerunner."
  },
  {
    id: "naruto-shippuden-600",
    title: "Naruto Shippuden",
    poster: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 500,
    dubCount: 500,
    description: "Naruto Uzumaki returns from rigorous training with Jiraiya, ready to face the mysterious Akatsuki organization and protect the Hidden Leaf Village."
  },
  {
    id: "bleach-thousand-year-blood-war-1234",
    title: "Bleach: Thousand-Year Blood War",
    poster: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 26,
    dubCount: 26,
    description: "The peace is suddenly broken when a new warning resounds through Soul Society. Ichigo Kurosaki returns to the battlefield with his Zanpakuto."
  },
  {
    id: "attack-on-titan-240",
    title: "Attack on Titan",
    poster: "https://images.unsplash.com/photo-1563089145-599997674d42?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 30,
    dubCount: 30,
    description: "Eren Jaeger leads the Survey Corps beyond the walls to uncover the truth of the world and fight for freedom against overwhelming global threats."
  },
  {
    id: "chainsaw-man-236",
    title: "Chainsaw Man",
    poster: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&auto=format&fit=crop",
    banner: "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1200&auto=format&fit=crop",
    type: "TV",
    subCount: 12,
    dubCount: 12,
    description: "Denji is a teenage boy living with a Chainsaw Devil named Pochita. Due to the debt his father left behind, he lives a rock-bottom life while repaying his debt by harvesting devil corpses."
  }
];

function filterMockAnime(query: string): AnimeItem[] {
  const q = query.toLowerCase().trim();
  const matched = FEATURED_ANIME.filter(a => 
    a.title.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)
  );
  if (matched.length > 0) return matched;

  // Dynamic fallback so any search query (e.g. Naruto, Bleach, etc.) returns a valid playable result
  return [
    {
      id: `${q.replace(/[^a-z0-9]+/g, '-')}-streaming`,
      title: query.charAt(0).toUpperCase() + query.slice(1),
      poster: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop",
      banner: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop",
      type: "TV",
      subCount: 24,
      dubCount: 24,
      description: `High-definition streaming results for "${query}" powered by ani-cli core engine.`
    }
  ];
}
