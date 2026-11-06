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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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

const memory = new Map<string, EpisodeInfo | null>();

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
    const saved = await readPersistedJson<EpisodeInfo | null>(`epinfo:${anime.id}|${n}`);
    if (saved) {
      memory.set(`${anime.id}|${n}`, saved.value);
      if (saved.value) out[n] = saved.value;
    } else {
      stillMissing.push(n);
    }
  }));
  if (stillMissing.length === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false)) return out;

  try {
    const id = await findKitsuId(anime, totalEpisodes);
    if (!id) return out;
    const whole = stillMissing.filter(n => /^\d+$/.test(n)); // "2.5"-style specials aren't on Kitsu's list
    for (let i = 0; i < whole.length; i += NUMBERS_PER_REQUEST) {
      const batch = whole.slice(i, i + NUMBERS_PER_REQUEST);
      const json = await getJson<{ data?: KitsuEpisode[] }>(
        `/anime/${id}/episodes?filter%5Bnumber%5D=${batch.join(',')}&page%5Blimit%5D=${NUMBERS_PER_REQUEST}` +
        `&fields%5Bepisodes%5D=number,canonicalTitle,titles,synopsis,thumbnail`
      );
      const byNumber = new Map<string, EpisodeInfo>();
      for (const ep of json.data || []) {
        const a = ep.attributes;
        if (a.number === undefined) continue;
        const title = a.canonicalTitle || a.titles?.en_us || a.titles?.en_jp;
        byNumber.set(String(a.number), {
          title: title || undefined,
          synopsis: a.synopsis?.trim() || undefined,
          thumbnail: a.thumbnail?.original || a.thumbnail?.large || undefined
        });
      }
      for (const n of batch) {
        const info = byNumber.get(n) ?? null;
        memory.set(`${anime.id}|${n}`, info);
        writePersistedJson(`epinfo:${anime.id}|${n}`, info);
        if (info) out[n] = info;
      }
    }
  } catch (err) {
    console.warn('[episodeInfo] unavailable:', err);
  }
  return out;
}
