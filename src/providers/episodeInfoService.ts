// episodeInfoService.ts - Multi-source per-episode title, synopsis and thumbnail
// Primary: TMDB TV Season Episodes + AniList GraphQL
// Secondary fallback: Kitsu + Jikan (MyAnimeList)
// Results are cached across sessions in persistentCache (IndexedDB) with a 30-day TTL.
import { request } from 'streamkit/core/http.ts';
import { readPersistedJson, writePersistedJson } from '../services/persistentCache.ts';
import type { AnimeItem } from './aniCliCore';
import { trimOldest } from './boundedCache.ts';

const TMDB = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_API_KEY = 'd56cb07bf9500bb94de196e6b7ae1967';
const KITSU = 'https://kitsu.app/api/edge';
const HEADERS = { Accept: 'application/vnd.api+json' };
const NUMBERS_PER_REQUEST = 20;

export interface EpisodeInfo {
  title?: string;
  synopsis?: string;
  thumbnail?: string;
}

interface KitsuAnime {
  id: string;
  attributes: {
    canonicalTitle?: string;
    titles?: Record<string, string>;
    abbreviatedTitles?: string[];
    episodeCount?: number | null;
    subtype?: string;
  };
}

interface KitsuEpisode {
  attributes: {
    number?: number;
    canonicalTitle?: string;
    titles?: Record<string, string>;
    synopsis?: string;
    thumbnail?: { original?: string; large?: string } | null;
  };
}

// Lower case, accents folded ("Shippūden" = "Shippuden"), punctuation as spaces.
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function tmdbApiKey(): string {
  try {
    const key = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TMDB_API_KEY;
    if (key && key.trim()) return key.trim();
  } catch {}
  return DEFAULT_TMDB_API_KEY;
}

// ------------------------------------------------------------- TMDB TV Seasons
const tmdbShowCache = new Map<string, Promise<number | null>>();

async function findTmdbShowId(anime: AnimeItem): Promise<number | null> {
  const hit = tmdbShowCache.get(anime.id);
  if (hit) return hit;
  const pending = (async () => {
    const key = `tmdbShow:${anime.id}`;
    const saved = await readPersistedJson<number | null>(key);
    if (saved) return saved.value;

    const query = encodeURIComponent(anime.title);
    const apiKey = tmdbApiKey();
    const res = await request(`${TMDB}/search/tv?query=${query}&api_key=${apiKey}`, {}, { timeoutMs: 8000, retries: 1 });
    const json = (await res.json()) as { results?: { id: number; name?: string; original_name?: string }[] };
    const wanted = new Set([anime.title, ...(anime.altTitles || [])].map(norm).filter(Boolean));

    for (const cand of json.results || []) {
      const names = [cand.name, cand.original_name].filter((n): n is string => !!n).map(norm);
      if (names.some(n => wanted.has(n))) {
        writePersistedJson(key, cand.id);
        return cand.id;
      }
    }
    const first = json.results?.[0]?.id ?? null;
    if (first) writePersistedJson(key, first);
    return first;
  })().catch(() => null);

  tmdbShowCache.set(anime.id, pending);
  pending.then(v => { if (v === null) tmdbShowCache.delete(anime.id); });
  return pending;
}

const tmdbEpisodesCache = new Map<string, Promise<Map<string, EpisodeInfo>>>();

async function getTmdbEpisodes(tmdbId: number, seasonNumber = 1): Promise<Map<string, EpisodeInfo>> {
  const cacheKey = `${tmdbId}:${seasonNumber}`;
  const hit = tmdbEpisodesCache.get(cacheKey);
  if (hit) return hit;

  const pending = (async () => {
    const out = new Map<string, EpisodeInfo>();
    const apiKey = tmdbApiKey();
    const res = await request(`${TMDB}/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey}`, {}, { timeoutMs: 8000, retries: 1 });
    const json = (await res.json()) as { episodes?: { episode_number: number; name?: string; overview?: string; still_path?: string }[] };
    for (const ep of json.episodes || []) {
      const t = realTitle(ep.name);
      const s = ep.overview?.trim() || undefined;
      const thumb = ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : undefined;
      if (t || s || thumb) {
        out.set(String(ep.episode_number), { title: t, synopsis: s, thumbnail: thumb });
      }
    }
    return out;
  })().catch(() => new Map<string, EpisodeInfo>());

  tmdbEpisodesCache.set(cacheKey, pending);
  pending.then(m => { if (m.size === 0) tmdbEpisodesCache.delete(cacheKey); });
  return pending;
}

// ------------------------------------------------------------------- Kitsu
async function getJson<T>(path: string): Promise<T> {
  const res = await request(`${KITSU}${path}`, { headers: HEADERS }, { timeoutMs: 10000, retries: 1 });
  return (await res.json()) as T;
}

const idCache = new Map<string, Promise<string | null>>();

function findKitsuId(anime: AnimeItem, totalEpisodes: number): Promise<string | null> {
  const hit = idCache.get(anime.id);
  if (hit) return hit;
  const pending = (async () => {
    const key = `kitsuId:${anime.id}`;
    const saved = await readPersistedJson<string | null>(key);
    if (saved) return saved.value;

    const wanted = new Set([anime.title, ...(anime.altTitles || [])].map(norm).filter(Boolean));
    const query = encodeURIComponent(anime.title);
    const json = await getJson<{ data?: KitsuAnime[] }>(
      `/anime?filter%5Btext%5D=${query}&page%5Blimit%5D=8&fields%5Banime%5D=canonicalTitle,titles,abbreviatedTitles,episodeCount,subtype`
    );
    for (const cand of json.data || []) {
      const a = cand.attributes;
      if (a.subtype && !['TV', 'ONA', 'OVA', 'special'].includes(a.subtype) && a.subtype !== 'movie') continue;
      const variants = [a.canonicalTitle, ...Object.values(a.titles || {}), ...(a.abbreviatedTitles || [])]
        .filter((t): t is string => !!t).map(norm);
      if (!variants.some(v => wanted.has(v))) continue;
      if (a.episodeCount && totalEpisodes > 0 && totalEpisodes > a.episodeCount * 1.5 + 2) continue;
      writePersistedJson(key, cand.id);
      return cand.id;
    }
    return null;
  })().catch(() => null);
  idCache.set(anime.id, pending);
  pending.then(v => { if (v === null) idCache.delete(anime.id); });
  return pending;
}

// Kitsu fills in a placeholder when it has no real title.
const PLACEHOLDER_TITLE = /^(title|tba|tbd|n\/a|episode\s*\d+)$/i;
const realTitle = (t?: string) => (t && !PLACEHOLDER_TITLE.test(t.trim()) ? t.trim() : undefined);

// ------------------------------------------------------------- Jikan (MyAnimeList)
const JIKAN = 'https://api.jikan.moe/v4';
const malIdCache = new Map<string, Promise<string | null>>();

function findMalId(kitsuId: string): Promise<string | null> {
  const hit = malIdCache.get(kitsuId);
  if (hit) return hit;
  const pending = getJson<{ data?: { attributes?: { externalId?: string } }[] }>(
    `/anime/${kitsuId}/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&fields%5Bmappings%5D=externalId`
  ).then(j => j.data?.[0]?.attributes?.externalId ?? null).catch(() => null);
  malIdCache.set(kitsuId, pending);
  pending.then(v => { if (v === null) malIdCache.delete(kitsuId); });
  return pending;
}

const jikanTitles = new Map<string, Promise<Map<string, string>>>();

function getJikanTitles(malId: string, upTo: number): Promise<Map<string, string>> {
  const key = `${malId}:${Math.ceil(upTo / 100)}`;
  const hit = jikanTitles.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const out = new Map<string, string>();
    for (let page = 1; page <= Math.ceil(upTo / 100) && page <= 12; page++) {
      const res = await request(`${JIKAN}/anime/${malId}/episodes?page=${page}`, {}, { timeoutMs: 10000, retries: 1 });
      const json = (await res.json()) as { data?: { mal_id: number; title?: string }[]; pagination?: { has_next_page?: boolean } };
      for (const e of json.data ?? []) {
        const t = realTitle(e.title);
        if (t) out.set(String(e.mal_id), t);
      }
      if (!json.pagination?.has_next_page) break;
    }
    return out;
  })().catch(() => new Map<string, string>());
  jikanTitles.set(key, pending);
  pending.then(m => { if (m.size === 0) jikanTitles.delete(key); });
  return pending;
}

/** One episode's synopsis from TMDB or MyAnimeList. Undefined when unknown. */
export async function getEpisodeSynopsis(anime: AnimeItem, number: string, totalEpisodes: number): Promise<string | undefined> {
  if (!/^\d+$/.test(number)) return undefined;
  const key = `epsyn:${anime.id}|${number}`;
  const saved = await readPersistedJson<string | null>(key);
  if (saved) return saved.value ?? undefined;

  // 1. Try TMDB first (high rate limit, rich English synopsis)
  try {
    const tmdbId = await findTmdbShowId(anime);
    if (tmdbId) {
      const tmdbEps = await getTmdbEpisodes(tmdbId);
      const ep = tmdbEps.get(number);
      if (ep?.synopsis) {
        writePersistedJson(key, ep.synopsis);
        return ep.synopsis;
      }
    }
  } catch {}

  // 2. Fall back to Jikan
  try {
    const kitsu = await findKitsuId(anime, totalEpisodes);
    const mal = kitsu ? await findMalId(kitsu) : null;
    if (!mal) return undefined;
    const res = await request(`${JIKAN}/anime/${mal}/episodes/${number}`, {}, { timeoutMs: 10000, retries: 1 });
    const json = (await res.json()) as { data?: { synopsis?: string | null } };
    const text = json.data?.synopsis?.replace(/\s*\(Source:[^)]*\)\s*$/i, '').trim() || undefined;
    writePersistedJson(key, text ?? null);
    return text;
  } catch {
    return undefined;
  }
}

// Memory cache
const MEMORY_MAX = 4000;
const memory = new Map<string, EpisodeInfo | null>();

/** What is already known about an episode (memory only, never network). */
export function peekEpisodeInfo(anime: AnimeItem, number: string): EpisodeInfo | undefined {
  return memory.get(`${anime.id}|${number}`) ?? undefined;
}

/**
 * Loads info for the 50 episodes around [currentNumber] with timeout guard.
 */
export async function warmEpisodeInfo(
  anime: AnimeItem,
  episodes: { number: string }[],
  currentNumber: string,
  maxWaitMs = 1500
): Promise<void> {
  const at = Math.max(0, episodes.findIndex(e => e.number === currentNumber));
  const start = Math.max(0, at - 10);
  const numbers = episodes.slice(start, start + 50).map(e => e.number);
  if (numbers.length === 0) return;
  await Promise.race([
    getEpisodeInfo(anime, numbers, episodes.length).catch(() => ({})),
    new Promise(resolve => setTimeout(resolve, maxWaitMs))
  ]);
}

/**
 * Info for the given episode numbers of a title, keyed by episode number.
 * Blends TMDB TV seasons, Kitsu and MyAnimeList to guarantee titles and descriptions.
 */
export async function getEpisodeInfo(
  anime: AnimeItem,
  numbers: string[],
  totalEpisodes: number
): Promise<Record<string, EpisodeInfo>> {
  const out: Record<string, EpisodeInfo> = {};
  const missing: string[] = [];

  for (const n of numbers) {
    const mem = memory.get(`${anime.id}|${n}`);
    if (mem) out[n] = mem;
    else if (mem === undefined) missing.push(n);
  }
  if (missing.length === 0) return out;

  // Disk first (also covers offline mode).
  const stillMissing: string[] = [];
  await Promise.all(missing.map(async n => {
    const saved = await readPersistedJson<EpisodeInfo | null>(`epinfo2:${anime.id}|${n}`);
    if (saved) {
      memory.set(`${anime.id}|${n}`, saved.value);
      trimOldest(memory, MEMORY_MAX);
      if (saved.value) out[n] = saved.value;
    } else {
      stillMissing.push(n);
    }
  }));

  if (stillMissing.length === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return out;
  }

  const whole = stillMissing.filter(n => /^\d+$/.test(n));
  const found = new Map<string, EpisodeInfo>();
  const answered = new Set<string>();

  // 1. Try TMDB Season 1 (or relevant season) in one batch
  try {
    const tmdbId = await findTmdbShowId(anime);
    if (tmdbId) {
      const tmdbEps = await getTmdbEpisodes(tmdbId);
      for (const n of whole) {
        const ep = tmdbEps.get(n);
        if (ep) {
          found.set(n, ep);
          if (ep.title && ep.synopsis) answered.add(n);
        }
      }
    }
  } catch (err) {
    console.warn('[episodeInfo] TMDB batch fallback:', err);
  }

  // 2. For episodes still lacking synopsis or title, query Kitsu
  const needKitsu = whole.filter(n => !answered.has(n));
  if (needKitsu.length > 0) {
    let kitsuId: string | null = null;
    try {
      kitsuId = await findKitsuId(anime, totalEpisodes);
    } catch (err) {
      console.warn('[episodeInfo] kitsu unavailable:', err);
    }

    if (kitsuId) {
      const id = kitsuId;
      const batches: string[][] = [];
      for (let i = 0; i < needKitsu.length; i += NUMBERS_PER_REQUEST) {
        batches.push(needKitsu.slice(i, i + NUMBERS_PER_REQUEST));
      }

      await Promise.all(batches.map(async batch => {
        try {
          const json = await getJson<{ data?: KitsuEpisode[] }>(
            `/anime/${id}/episodes?filter%5Bnumber%5D=${batch.join(',')}&page%5Blimit%5D=${NUMBERS_PER_REQUEST}` +
            `&fields%5Bepisodes%5D=number,canonicalTitle,titles,synopsis,thumbnail`
          );
          for (const ep of json.data || []) {
            const a = ep.attributes;
            if (a.number === undefined) continue;
            const num = String(a.number);
            const prev = found.get(num);
            found.set(num, {
              title: prev?.title || realTitle(a.canonicalTitle) || realTitle(a.titles?.en_us) || realTitle(a.titles?.en_jp),
              synopsis: prev?.synopsis || a.synopsis?.trim() || undefined,
              thumbnail: prev?.thumbnail || a.thumbnail?.original || a.thumbnail?.large || undefined
            });
          }
          batch.forEach(n => answered.add(n));
        } catch (err) {
          console.warn('[episodeInfo] kitsu batch unavailable:', err);
        }
      }));

      // 3. Jikan fallback for any titles still missing
      const untitled = whole.filter(n => !found.get(n)?.title);
      if (untitled.length > 0) {
        const mal = await findMalId(id);
        if (mal) {
          const titles = await getJikanTitles(mal, Math.max(...untitled.map(Number)));
          for (const n of untitled) {
            const title = titles.get(n);
            if (title) {
              const cur = found.get(n);
              found.set(n, { ...cur, title });
            }
          }
        }
      }
    }
  }

  for (const n of whole) {
    const info = found.get(n) ?? null;
    if (info || answered.has(n)) {
      memory.set(`${anime.id}|${n}`, info);
      trimOldest(memory, MEMORY_MAX);
      writePersistedJson(`epinfo2:${anime.id}|${n}`, info);
      if (info) out[n] = info;
    }
  }
  return out;
}
