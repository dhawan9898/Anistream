// episodeInfoService.ts - Per-episode title, synopsis and thumbnail from Kitsu
// (https://kitsu.app, public API, no key). The streaming site only knows
// episode numbers and titles, so this is what makes an episode row look like
// Netflix's. It is optional enrichment: when the show can't be matched with
// confidence (or the request fails / is offline) rows simply keep the site's data.
import { request } from 'streamkit/core/http.ts';
import { readPersistedJson, writePersistedJson } from '../services/persistentCache.ts';
import type { AnimeItem } from './aniCliCore';

const KITSU = 'https://kitsu.app/api/edge';
const HEADERS = { Accept: 'application/vnd.api+json' };
const NUMBERS_PER_REQUEST = 20; // Kitsu's page-size ceiling

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

async function getJson<T>(path: string): Promise<T> {
  const res = await request(`${KITSU}${path}`, { headers: HEADERS }, { timeoutMs: 10000, retries: 1 });
  return (await res.json()) as T;
}

// Kitsu id for a site title, or null when nothing matches confidently.
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
      // A different-length run is a different season/series.
      if (a.episodeCount && totalEpisodes > 0 && totalEpisodes > a.episodeCount * 1.5 + 2) continue;
      writePersistedJson(key, cand.id);
      return cand.id;
    }
    return null;
  })().catch(() => null);
  idCache.set(anime.id, pending);
  // Don't remember a failed lookup for the whole session.
  pending.then(v => { if (v === null) idCache.delete(anime.id); });
  return pending;
}

// Kitsu fills in a placeholder when it has no real title.
const PLACEHOLDER_TITLE = /^(title|tba|tbd|n\/a|episode\s*\d+)$/i;
const realTitle = (t?: string) => (t && !PLACEHOLDER_TITLE.test(t.trim()) ? t.trim() : undefined);

// ---- Jikan (MyAnimeList): fills the gaps Kitsu leaves in long series (e.g. no title or synopsis
// past episode ~100 of Naruto). Optional: any failure just leaves the Kitsu data as it is. ----
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

/** Episode titles by number from MyAnimeList's episode list (100 per page, fetched as needed). */
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

/** One episode's synopsis from MyAnimeList, for a row the viewer opened. Undefined when unknown. */
export async function getEpisodeSynopsis(anime: AnimeItem, number: string, totalEpisodes: number): Promise<string | undefined> {
  if (!/^\d+$/.test(number)) return undefined;
  const key = `epsyn:${anime.id}|${number}`;
  const saved = await readPersistedJson<string | null>(key);
  if (saved) return saved.value ?? undefined;
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

const memory = new Map<string, EpisodeInfo | null>();

/** What is already known about an episode (memory only, never touches the network). */
export function peekEpisodeInfo(anime: AnimeItem, number: string): EpisodeInfo | undefined {
  return memory.get(`${anime.id}|${number}`) ?? undefined;
}

/**
 * Loads info for the 50 episodes around [currentNumber] so the player's episode list has it, but
 * never holds playback up for more than [maxWaitMs].
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
 * Info for the given episode numbers of a title, keyed by the number as the
 * site writes it. Missing numbers are simply absent. Results are cached
 * (memory + disk), so revisiting a page is instant and works offline.
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

  // Disk first (also covers offline).
  const stillMissing: string[] = [];
  await Promise.all(missing.map(async n => {
    const saved = await readPersistedJson<EpisodeInfo | null>(`epinfo2:${anime.id}|${n}`);
    if (saved) {
      memory.set(`${anime.id}|${n}`, saved.value);
      if (saved.value) out[n] = saved.value;
    } else {
      stillMissing.push(n);
    }
  }));
  if (stillMissing.length === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false)) return out;

  let kitsuId: string | null = null;
  try {
    kitsuId = await findKitsuId(anime, totalEpisodes);
  } catch (err) {
    console.warn('[episodeInfo] unavailable:', err);
  }
  if (!kitsuId) return out;
  const id = kitsuId;

  const whole = stillMissing.filter(n => /^\d+$/.test(n)); // "2.5"-style specials aren't on Kitsu's list
  const batches: string[][] = [];
  for (let i = 0; i < whole.length; i += NUMBERS_PER_REQUEST) batches.push(whole.slice(i, i + NUMBERS_PER_REQUEST));

  // Batches run side by side and fail on their own: one bad page no longer drops the rest of the
  // range (which left everything past the first page without thumbnails), and a batch that
  // failed is not remembered as "no data", so it is retried next time.
  const found = new Map<string, EpisodeInfo>();
  const answered = new Set<string>();
  await Promise.all(batches.map(async batch => {
    try {
      const json = await getJson<{ data?: KitsuEpisode[] }>(
        `/anime/${id}/episodes?filter%5Bnumber%5D=${batch.join(',')}&page%5Blimit%5D=${NUMBERS_PER_REQUEST}` +
        `&fields%5Bepisodes%5D=number,canonicalTitle,titles,synopsis,thumbnail`
      );
      for (const ep of json.data || []) {
        const a = ep.attributes;
        if (a.number === undefined) continue;
        found.set(String(a.number), {
          title: realTitle(a.canonicalTitle) || realTitle(a.titles?.en_us) || realTitle(a.titles?.en_jp),
          synopsis: a.synopsis?.trim() || undefined,
          thumbnail: a.thumbnail?.original || a.thumbnail?.large || undefined
        });
      }
      batch.forEach(n => answered.add(n));
    } catch (err) {
      console.warn('[episodeInfo] batch unavailable:', err);
    }
  }));

  // Titles Kitsu lacks come from MyAnimeList's list.
  const untitled = whole.filter(n => !found.get(n)?.title);
  if (untitled.length > 0) {
    const mal = await findMalId(id);
    if (mal) {
      const titles = await getJikanTitles(mal, Math.max(...untitled.map(Number)));
      for (const n of untitled) {
        const title = titles.get(n);
        if (title) found.set(n, { ...found.get(n), title });
      }
    }
  }

  for (const n of whole) {
    if (!answered.has(n)) continue;
    const info = found.get(n) ?? null;
    memory.set(`${anime.id}|${n}`, info);
    writePersistedJson(`epinfo2:${anime.id}|${n}`, info);
    if (info) out[n] = info;
  }
  return out;
}
