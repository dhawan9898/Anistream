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
import { trimOldest } from './boundedCache.ts';

const TMDB = 'https://api.themoviedb.org/3';
const STORY_ARC = 5;
const ARC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A single season (12-26 episodes) is not split into arcs: TMDB's arc groups for a franchise
// span several seasons, and cutting one season by them gives meaningless "arcs".
export const MIN_EPISODES_FOR_ARCS = 40;

/** Episodes [start, end] (1-based, inclusive) of one arc. */
export interface StoryArc {
  name: string;
  start: number;
  end: number;
}

interface TmdbSearchTv { results?: { id: number; name?: string; original_name?: string; origin_country?: string[]; genre_ids?: number[] }[] }
interface TmdbGroupList { results?: TmdbGroupSummary[] }
interface TmdbGroupDetails { groups?: { name: string; order: number; episodes: { order: number; season_number?: number; episode_number?: number }[] }[] }

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

// Lower case, accents folded ("Shippūden" = "Shippuden"), punctuation as spaces.
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function tmdb<T>(path: string, key: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await request(`${TMDB}${path}${sep}api_key=${encodeURIComponent(key)}`, {}, { timeoutMs: 8000, retries: 1 });
  return (await res.json()) as T;
}

/**
 * The arcs of an episode group as episode ranges in the group's order, cut to the episodes the site
 * actually has. When TMDB numbers the show's episodes absolutely (One Piece: 1, 2, ... 1180 across
 * its seasons), each arc spans its real episode numbers and the filler between two arcs joins the arc
 * before it; otherwise arcs are laid end to end by their episode counts. Empty when the result would
 * not be a useful picker (one arc), or when the group clearly does not match the site's numbering.
 */
export function arcsFromGroup(details: TmdbGroupDetails, siteEpisodes: number): StoryArc[] {
  // Specials (TMDB's season 0) are not in the site's numbering: counting them shifted every arc
  // after them (One Piece's official list opens with 7 TV specials).
  const groups = [...(details.groups ?? [])]
    .sort((a, b) => a.order - b.order)
    .map(g => ({ ...g, episodes: g.episodes.filter(e => e.season_number !== 0) }))
    .filter(g => g.episodes.length > 0);
  const total = groups.reduce((n, g) => n + g.episodes.length, 0);
  if (groups.length < 2 || siteEpisodes < MIN_EPISODES_FOR_ARCS) return [];
  // Recaps / specials counted differently are fine; a different show or season split is not.
  if (total < siteEpisodes * 0.8 || total > siteEpisodes * 1.25 + 30) return [];
  const name = (g: { name: string }, i: number) => g.name.trim() || `Arc ${i + 1}`;

  const numbers = groups.flatMap(g => g.episodes.map(e => e.episode_number));
  const absolute = numbers.every((n, i) => typeof n === 'number' && (i === 0 || n > (numbers[i - 1] as number)))
    && (numbers[numbers.length - 1] as number) <= siteEpisodes + 30;

  const arcs: StoryArc[] = [];
  if (absolute) {
    groups.forEach((g, i) => {
      const own = g.episodes.map(e => e.episode_number as number);
      const nextStart = groups[i + 1]?.episodes[0]?.episode_number as number | undefined;
      const start = i === 0 ? 1 : arcs[arcs.length - 1].end + 1;
      const end = Math.min(siteEpisodes, nextStart !== undefined ? nextStart - 1 : Math.max(...own));
      if (start <= end) arcs.push({ name: name(g, i), start, end });
    });
  } else {
    let next = 1;
    groups.forEach((g, i) => {
      if (next > siteEpisodes) return;
      const end = Math.min(siteEpisodes, next + g.episodes.length - 1);
      arcs.push({ name: name(g, i), start: next, end });
      next = end + 1;
    });
  }
  // Episodes the group does not cover yet (an ongoing show): one last range, labelled as such.
  const covered = arcs.length > 0 ? arcs[arcs.length - 1].end : 0;
  if (covered < siteEpisodes) arcs.push({ name: 'Latest episodes', start: covered + 1, end: siteEpisodes });
  return arcs.length > 1 ? arcs : [];
}

export interface TmdbGroupSummary { id: string; type: number; group_count: number; episode_count: number; name?: string }

// Groups that cut the show some other way (broadcast seasons, release orders, a streaming service's
// split), even when TMDB files them as story arcs.
const FOREIGN = /french|italian|german|spanish|portugu|brazil|latin|castellano|chinese|japanese|korean|arabic|polish|russian|turkish|hindi/i;
const NOT_ARCS = /season|order|blu-?ray|dvd|release|wikipedia|netflix|crunchyroll|hulu|funimation|prime|iplayer|apple|tvdb|correct/i;

/**
 * The episode groups worth trying as story arcs, best first. TMDB files arcs under "Story Arc"
 * (type 5) for some shows and under other types for others (Naruto Shippuden's official arcs are a
 * type 2 group), so any group named as arcs or sagas counts. Groups whose episode total does not
 * fit the site's count are left out; then the official list wins, then an English one, then type 5,
 * then the closest total.
 */
export function rankArcGroups(groups: TmdbGroupSummary[], siteEpisodes: number): TmdbGroupSummary[] {
  const fits = (g: TmdbGroupSummary) =>
    g.episode_count >= siteEpisodes * 0.8 && g.episode_count <= siteEpisodes * 1.25 + 30;
  const official = (g: TmdbGroupSummary) => (/official/i.test(g.name || '') ? 0 : 1);
  // A list made for one country ("French Arcs", "Italian Sagas") may carry translated names.
  const localized = (g: TmdbGroupSummary) => (FOREIGN.test(g.name || '') || [...(g.name || '')].some(c => c.charCodeAt(0) > 127) ? 1 : 0);
  return groups
    .filter(g => g.group_count > 1 && (g.type === STORY_ARC || /\barcs?\b|\bsagas?\b/i.test(g.name || ''))
      && !NOT_ARCS.test(g.name || '') && fits(g))
    .sort((a, b) => official(a) - official(b)
      || localized(a) - localized(b)
      || (a.type === STORY_ARC ? 0 : 1) - (b.type === STORY_ARC ? 0 : 1)
      || Math.abs(a.episode_count - siteEpisodes) - Math.abs(b.episode_count - siteEpisodes));
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
  if (!key || siteEpisodes < MIN_EPISODES_FOR_ARCS) return Promise.resolve([]);
  const cacheKey = `arcs3:${anime.id}:${siteEpisodes}`;
  const hit = memory.get(cacheKey);
  if (hit) return hit;
  const pending = (async () => {
    const saved = await readPersistedJson<StoryArc[]>(cacheKey);
    if (saved && Date.now() - saved.savedAt < ARC_TTL_MS) return saved.value;
    try {
      const tvId = await findTv(anime, key);
      if (!tvId) return [];
      const list = await tmdb<TmdbGroupList>(`/tv/${tvId}/episode_groups`, key);
      // The best few candidates, in order, until one cuts the site's episodes into arcs.
      let arcs: StoryArc[] = [];
      for (const group of rankArcGroups(list.results ?? [], siteEpisodes).slice(0, 3)) {
        arcs = arcsFromGroup(await tmdb<TmdbGroupDetails>(`/tv/episode_group/${group.id}`, key), siteEpisodes);
        if (arcs.length > 0) break;
      }
      writePersistedJson(cacheKey, arcs);
      return arcs;
    } catch {
      return []; // offline or TMDB down: ranges for now, try again next time
    }
  })();
  memory.set(cacheKey, pending);
  trimOldest(memory, 100);
  pending.then(a => { if (a.length === 0) memory.delete(cacheKey); }).catch(() => memory.delete(cacheKey));
  return pending;
}
