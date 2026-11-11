// arcService.ts - Story arcs of a long-running series ("East Blue", "Alabasta"...), shown in the
// episode picker of a title page instead of plain blocks of 50 episodes.
//
// Arcs come from TMDB's episode groups of type "Story arc" (type 5), which exist for most long
// anime (One Piece, Naruto, Bleach, Dragon Ball...). They need a TMDB API key, read at build time
// from VITE_TMDB_API_KEY; without one, or when TMDB has no arcs for a show or its numbering does not
// fit the site's, there are simply no arcs and the picker keeps its episode ranges.
import { request } from 'streamkit/core/http.ts';
import { readPersistedJson, writePersistedJson } from '../services/persistentCache.ts';
import type { AnimeItem } from './aniCliCore';

const TMDB = 'https://api.themoviedb.org/3';
const STORY_ARC = 5;
const ARC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Episodes [start, end] (1-based, inclusive) of one arc. */
export interface StoryArc {
  name: string;
  start: number;
  end: number;
}

interface TmdbSearchTv { results?: { id: number; name?: string; original_name?: string; origin_country?: string[]; genre_ids?: number[] }[] }
interface TmdbGroupList { results?: { id: string; type: number; group_count: number; episode_count: number; name?: string }[] }
interface TmdbGroupDetails { groups?: { name: string; order: number; episodes: { order: number }[] }[] }

const DEFAULT_TMDB_API_KEY = 'd56cb07bf9500bb94de196e6b7ae1967';

function apiKey(): string | undefined {
  try {
    const key = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_TMDB_API_KEY;
    if (key && key.trim()) return key.trim();
    return DEFAULT_TMDB_API_KEY;
  } catch {
    return DEFAULT_TMDB_API_KEY;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function tmdb<T>(path: string, key: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await request(`${TMDB}${path}${sep}api_key=${encodeURIComponent(key)}`, {}, { timeoutMs: 8000, retries: 1 });
  return (await res.json()) as T;
}

/**
 * The arcs of an episode group, as consecutive episode ranges in the group's order, cut to the
 * episodes the site actually has. Empty when the result would not be a useful picker (one arc), or
 * when the group's numbering clearly does not match the site's (very different episode totals).
 */
export function arcsFromGroup(details: TmdbGroupDetails, siteEpisodes: number): StoryArc[] {
  const groups = [...(details.groups ?? [])].sort((a, b) => a.order - b.order).filter(g => g.episodes.length > 0);
  const total = groups.reduce((n, g) => n + g.episodes.length, 0);
  if (groups.length < 2 || siteEpisodes <= 0) return [];
  // Recaps / specials counted differently are fine; a different show or season split is not.
  if (total < siteEpisodes * 0.8 || total > siteEpisodes * 1.25 + 30) return [];
  const arcs: StoryArc[] = [];
  let next = 1;
  for (const g of groups) {
    if (next > siteEpisodes) break;
    const end = Math.min(siteEpisodes, next + g.episodes.length - 1);
    arcs.push({ name: g.name.trim() || `Arc ${arcs.length + 1}`, start: next, end });
    next = end + 1;
  }
  // Episodes the group does not cover yet (an ongoing show): one last range, labelled as such.
  if (next <= siteEpisodes) arcs.push({ name: 'Latest episodes', start: next, end: siteEpisodes });
  return arcs.length > 1 ? arcs : [];
}

/** TMDB's id for the show, matched by name (and its alternative titles) among animated series. */
async function findTv(anime: AnimeItem, key: string): Promise<number | null> {
  const wanted = new Set([anime.title, ...(anime.altTitles ?? [])].map(norm).filter(Boolean));
  const json = await tmdb<TmdbSearchTv>(`/search/tv?query=${encodeURIComponent(anime.title)}`, key);
  const candidates = (json.results ?? []).filter(r => (r.genre_ids ?? []).includes(16));
  const exact = candidates.find(r => [r.name, r.original_name].some(n => n && wanted.has(norm(n))));
  return (exact ?? candidates[0])?.id ?? null;
}

const memory = new Map<string, Promise<StoryArc[]>>();

/** The story arcs for a title with [siteEpisodes] episodes, or [] when there are none to show. */
export function getStoryArcs(anime: AnimeItem, siteEpisodes: number): Promise<StoryArc[]> {
  const key = apiKey();
  if (!key || siteEpisodes < 2) return Promise.resolve([]);
  const cacheKey = `arcs:${anime.id}:${siteEpisodes}`;
  const hit = memory.get(cacheKey);
  if (hit) return hit;
  const pending = (async () => {
    const saved = await readPersistedJson<StoryArc[]>(cacheKey);
    if (saved && Date.now() - saved.savedAt < ARC_TTL_MS) return saved.value;
    try {
      const tvId = await findTv(anime, key);
      if (!tvId) return [];
      const list = await tmdb<TmdbGroupList>(`/tv/${tvId}/episode_groups`, key);
      // The story-arc group whose size is closest to the site's episode count.
      const group = (list.results ?? [])
        .filter(g => g.type === STORY_ARC && g.group_count > 1)
        .sort((a, b) => Math.abs(a.episode_count - siteEpisodes) - Math.abs(b.episode_count - siteEpisodes))[0];
      const arcs = group ? arcsFromGroup(await tmdb<TmdbGroupDetails>(`/tv/episode_group/${group.id}`, key), siteEpisodes) : [];
      writePersistedJson(cacheKey, arcs);
      return arcs;
    } catch {
      return []; // offline or TMDB down: ranges for now, try again next time
    }
  })();
  memory.set(cacheKey, pending);
  pending.then(a => { if (a.length === 0) memory.delete(cacheKey); }).catch(() => memory.delete(cacheKey));
  return pending;
}
