// catalogService.ts - Genre browsing plus the "Collection" (other seasons /
// related entries) and "More Like This" (suggestions) rails on an anime's
// page, Netflix-style.
//
// Primary source is the streaming site itself (the same HTML the rest of
// aniCliCore scrapes): its genre pages, and the season switcher / "Related
// Anime" / "Recommended" blocks on an anime's own page. When the site gives
// nothing back (blocked, markup changed), this falls back to MyAnimeList via
// the public Jikan API - entries found that way carry a malId and are matched
// to a real site entry by title (resolveAnime) before they can be played.
import {
  fetchSiteHtml,
  parseSearchResults,
  searchAnimeLive,
  sitePathOf,
  type AnimeItem
} from '../core/aniCliCore';
import { resolveMalId } from './aniSkipService';

export interface Genre {
  slug: string;
  name: string;
  // Site path of the genre's listing page.
  path: string;
  // MyAnimeList genre id, used only for the Jikan fallback.
  malId?: number;
}

export interface GenrePage {
  items: AnimeItem[];
  hasMore: boolean;
}

export interface AnimeDetails {
  description?: string;
  genres: string[];
  // Other seasons/parts/movies of the same franchise, in site order. May
  // include the anime itself (flagged by id) so the rail reads as a whole
  // collection.
  collection: AnimeItem[];
  suggestions: AnimeItem[];
}

// slug -> [display name, MAL genre id]
const GENRE_TABLE: [string, string, number?][] = [
  ['action', 'Action', 1],
  ['adventure', 'Adventure', 2],
  ['cars', 'Cars', 3],
  ['comedy', 'Comedy', 4],
  ['dementia', 'Dementia', 5],
  ['demons', 'Demons', 6],
  ['drama', 'Drama', 8],
  ['ecchi', 'Ecchi', 9],
  ['fantasy', 'Fantasy', 10],
  ['game', 'Game', 11],
  ['harem', 'Harem', 35],
  ['historical', 'Historical', 13],
  ['horror', 'Horror', 14],
  ['isekai', 'Isekai', 62],
  ['josei', 'Josei', 43],
  ['kids', 'Kids', 15],
  ['magic', 'Magic'],
  ['martial-arts', 'Martial Arts', 17],
  ['mecha', 'Mecha', 18],
  ['military', 'Military', 38],
  ['music', 'Music', 19],
  ['mystery', 'Mystery', 7],
  ['parody', 'Parody', 20],
  ['police', 'Police', 39],
  ['psychological', 'Psychological', 40],
  ['romance', 'Romance', 22],
  ['samurai', 'Samurai', 21],
  ['school', 'School', 23],
  ['sci-fi', 'Sci-Fi', 24],
  ['seinen', 'Seinen', 42],
  ['shoujo', 'Shoujo', 25],
  ['shoujo-ai', 'Shoujo Ai', 26],
  ['shounen', 'Shounen', 27],
  ['shounen-ai', 'Shounen Ai', 28],
  ['slice-of-life', 'Slice of Life', 36],
  ['space', 'Space', 29],
  ['sports', 'Sports', 30],
  ['super-power', 'Super Power', 31],
  ['supernatural', 'Supernatural', 37],
  ['thriller', 'Thriller', 41],
  ['vampire', 'Vampire', 32]
];

export const DEFAULT_GENRES: Genre[] = GENRE_TABLE.map(([slug, name, malId]) => ({
  slug,
  name,
  path: `/genre/${slug}`,
  malId
}));

const JIKAN = 'https://api.jikan.moe/v4';
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function jikanToAnime(entry: any): AnimeItem | null {
  if (!entry || typeof entry.mal_id !== 'number') return null;
  const poster = entry.images?.webp?.large_image_url || entry.images?.jpg?.large_image_url
    || entry.images?.webp?.image_url || entry.images?.jpg?.image_url || '';
  const title = entry.title_english || entry.title || '';
  if (!title || !poster) return null;
  const altTitles = [entry.title, entry.title_english, ...(entry.title_synonyms || [])]
    .filter((t: unknown): t is string => typeof t === 'string' && !!t && t !== title);
  return {
    id: `mal-${entry.mal_id}`,
    malId: entry.mal_id,
    title,
    altTitles,
    poster,
    type: entry.type || undefined,
    subCount: typeof entry.episodes === 'number' ? entry.episodes : undefined,
    description: entry.synopsis || undefined,
    genres: Array.isArray(entry.genres) ? entry.genres.map((g: any) => g.name).filter(Boolean) : undefined
  };
}

function dedupe(items: AnimeItem[], exclude: Set<string> = new Set()): AnimeItem[] {
  const seen = new Set(exclude);
  return items.filter(item => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// ---------------------------------------------------------------- genres

let genresCache: Promise<Genre[]> | null = null;

// The site's own genre links (from its home page sidebar/menu) when they can
// be read - so the paths are the site's real ones - otherwise the standard
// list. Either way every genre keeps its MAL id for the fallback.
export function getGenres(): Promise<Genre[]> {
  if (!genresCache) {
    genresCache = (async () => {
      try {
        const html = await fetchSiteHtml('/home');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const found: Genre[] = [];
        const seen = new Set<string>();
        doc.querySelectorAll('a[href*="/genre/"]').forEach(a => {
          const path = sitePathOf(a.getAttribute('href') || '');
          const slug = path.split('/').filter(Boolean).pop() || '';
          const name = (a.getAttribute('title') || a.textContent || '').trim();
          if (!path || !slug || !name || seen.has(slug)) return;
          seen.add(slug);
          const known = GENRE_TABLE.find(([s]) => s === slug);
          found.push({ slug, name, path, malId: known?.[2] });
        });
        if (found.length >= 5) {
          return found.sort((a, b) => a.name.localeCompare(b.name));
        }
      } catch (err) {
        console.warn('[catalogService] Could not read genre links from the site:', err);
      }
      return DEFAULT_GENRES;
    })();
  }
  return genresCache;
}

const genrePageCache = new Map<string, Promise<GenrePage>>();

// One page of a genre's listing, most popular first. Cached for the session
// so backing out of a title into a genre page (or the home rails) doesn't
// refetch everything.
export function getAnimeByGenre(genre: Genre, page = 1): Promise<GenrePage> {
  const key = `${genre.path}#${page}`;
  const cached = genrePageCache.get(key);
  if (cached) return cached;
  const pending = loadGenrePage(genre, page);
  genrePageCache.set(key, pending);
  pending.then(result => {
    if (result.items.length === 0) genrePageCache.delete(key);
  });
  return pending;
}

async function loadGenrePage(genre: Genre, page: number): Promise<GenrePage> {
  try {
    const sep = genre.path.includes('?') ? '&' : '?';
    const html = await fetchSiteHtml(`${genre.path}${sep}page=${page}`);
    const items = parseSearchResults(html);
    if (items.length > 0) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const pagination = doc.querySelector('.pagination, .pre-pagination');
      const hasNextLink = !!pagination?.querySelector(`a[href*="page=${page + 1}"], a[title="Next"]`);
      return { items, hasMore: pagination ? hasNextLink : items.length >= 18 };
    }
  } catch (err) {
    console.warn(`[catalogService] Genre page ${genre.path} failed, trying MyAnimeList:`, err);
  }

  if (!genre.malId) return { items: [], hasMore: false };
  try {
    const data = await fetchJson(
      `${JIKAN}/anime?genres=${genre.malId}&order_by=members&sort=desc&sfw=true&limit=24&page=${page}`
    );
    const items = (data?.data || []).map(jikanToAnime).filter(Boolean) as AnimeItem[];
    return { items: dedupe(items), hasMore: !!data?.pagination?.has_next_page };
  } catch (err) {
    console.warn('[catalogService] MyAnimeList genre lookup failed:', err);
    return { items: [], hasMore: false };
  }
}

// --------------------------------------------------------- title matching

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// "Mushoku Tensei: Jobless Reincarnation Season 2 Part 2" -> "mushoku tensei"
function franchiseKey(title: string): string {
  const head = title.split(/[:\-–(]/)[0];
  return normalizeTitle(head)
    .replace(/\b(season|part|cour)\s*\d+\b.*$/, '')
    .replace(/\b\d+(st|nd|rd|th)\s+season\b.*$/, '')
    .replace(/\b(ii|iii|iv|2|3|4|5)$/, '')
    .trim();
}

// Entries from MyAnimeList (malId set, "mal-" id) have no streaming-site id
// yet - search the site under each of the entry's known titles and adopt a
// result whose title actually matches. Never falls back to an unrelated
// first result: throws if nothing matches. Site entries are returned as-is.
export async function resolveAnime(anime: AnimeItem): Promise<AnimeItem> {
  if (!anime.id.startsWith('mal-')) return anime;
  const titles = Array.from(new Set([anime.title, ...(anime.altTitles || [])]));
  for (const title of titles) {
    const wanted = normalizeTitle(title);
    if (!wanted) continue;
    let results: AnimeItem[] = [];
    try {
      results = await searchAnimeLive(title);
    } catch (err) {
      console.warn('[catalogService] resolve search failed:', err);
      continue;
    }
    const best = results.find(r => normalizeTitle(r.title) === wanted)
      || results.find(r => {
        const got = normalizeTitle(r.title);
        return got.length >= 3 && (got.startsWith(wanted) || wanted.startsWith(got));
      });
    if (best) {
      return {
        ...best,
        description: best.description || anime.description,
        genres: best.genres || anime.genres,
        malId: anime.malId
      };
    }
  }
  throw new Error(`"${anime.title}" was not found on the streaming site`);
}

// ------------------------------------------------------------ detail page

function posterOf(el: Element | null): string {
  if (!el) return '';
  const img = el.querySelector('img');
  const fromImg = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
  if (fromImg.startsWith('http') || fromImg.startsWith('//')) return fromImg;
  // Season switcher tiles carry the poster as a CSS background image.
  const styled = el.querySelector('[style*="background-image"]') as HTMLElement | null;
  const match = (styled?.getAttribute('style') || el.getAttribute('style') || '').match(/url\((['"]?)(.*?)\1\)/);
  return match ? match[2] : '';
}

function linkToAnime(a: Element, container: Element, label?: string): AnimeItem | null {
  const href = a.getAttribute('href') || '';
  const path = sitePathOf(href);
  const id = path.split('/').filter(Boolean).pop() || '';
  const title = (a.getAttribute('title') || a.getAttribute('data-jname') || a.textContent || '').trim();
  const poster = posterOf(container);
  if (!id || !title || id === 'home') return null;
  return { id, path, title, poster, seasonLabel: label, type: 'TV' };
}

interface ParsedDetailPage {
  description?: string;
  genres: string[];
  seasons: AnimeItem[];
  related: AnimeItem[];
  recommended: AnimeItem[];
}

export function parseDetailPage(html: string): ParsedDetailPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const description = (
    doc.querySelector('.film-description .text')?.textContent
    || doc.querySelector('.anisc-detail .film-description')?.textContent
    || ''
  ).trim() || undefined;

  const genres = Array.from(new Set(
    Array.from(doc.querySelectorAll('.anisc-info a[href*="/genre/"], .anisc-detail a[href*="/genre/"]'))
      .map(a => (a.getAttribute('title') || a.textContent || '').trim())
      .filter(Boolean)
  ));

  // Season switcher: <div class="os-list"><a class="os-item" href title>
  //   <div class="title">Season 2</div><div class="season-poster" style="background-image:url(..)">
  const seasons: AnimeItem[] = [];
  doc.querySelectorAll('.os-list a').forEach(a => {
    const label = a.querySelector('.title')?.textContent?.trim();
    const item = linkToAnime(a, a, label);
    if (item) {
      if (!a.getAttribute('title') && label) item.title = label;
      seasons.push(item);
    }
  });

  // Titled blocks ("Related Anime", "Recommended for you", ...).
  const related: AnimeItem[] = [];
  const recommended: AnimeItem[] = [];
  doc.querySelectorAll('.block_area').forEach(block => {
    const heading = block.querySelector('.cat-heading, .block_area-header h2, h2')?.textContent || '';
    if (/related/i.test(heading)) {
      block.querySelectorAll('li, .flw-item').forEach(li => {
        const a = li.querySelector('.film-name a, a.film-poster-ahref, a[href]');
        const item = a ? linkToAnime(a, li) : null;
        if (item && item.poster) related.push(item);
      });
    } else if (/recommend|you may also like|similar/i.test(heading)) {
      // parseSearchResults drops anything inside #main-sidebar, so parse
      // just this block's markup.
      recommended.push(...parseSearchResults(`<div>${block.innerHTML}</div>`));
    }
  });

  return { description, genres, seasons, related: dedupe(related), recommended: dedupe(recommended) };
}

const detailsCache = new Map<string, Promise<AnimeDetails>>();

export function getAnimeDetails(anime: AnimeItem): Promise<AnimeDetails> {
  const cached = detailsCache.get(anime.id);
  if (cached) return cached;
  const pending = loadAnimeDetails(anime);
  detailsCache.set(anime.id, pending);
  // Don't pin a failed/empty lookup forever - let a later visit retry.
  pending.then(d => {
    if (d.collection.length === 0 && d.suggestions.length === 0) detailsCache.delete(anime.id);
  });
  return pending;
}

async function loadAnimeDetails(anime: AnimeItem): Promise<AnimeDetails> {
  let parsed: ParsedDetailPage = { genres: [], seasons: [], related: [], recommended: [] };
  const candidates = Array.from(new Set([anime.path, `/${anime.id}`].filter(Boolean) as string[]));
  for (const path of candidates) {
    try {
      parsed = parseDetailPage(await fetchSiteHtml(path));
      break;
    } catch (err) {
      console.warn(`[catalogService] Detail page ${path} failed:`, err);
    }
  }

  let collection = dedupe([...parsed.seasons, ...parsed.related]);
  let suggestions = dedupe(parsed.recommended, new Set(collection.map(c => c.id).concat(anime.id)));
  let description = parsed.description;
  let genres = parsed.genres;

  // Collection fallback: other site entries sharing this franchise's base
  // title (e.g. every "Mushoku Tensei" season).
  if (collection.length <= 1) {
    const key = franchiseKey(anime.title);
    if (key.length >= 3) {
      try {
        const results = await searchAnimeLive(key);
        const family = results.filter(r => franchiseKey(r.title) === key || normalizeTitle(r.title).startsWith(key));
        if (family.some(r => r.id !== anime.id)) {
          collection = dedupe([anime, ...family]);
        }
      } catch (err) {
        console.warn('[catalogService] Collection search failed:', err);
      }
    }
  }

  // Suggestions / synopsis fallback: MyAnimeList.
  const needsMal = suggestions.length === 0 || !description || genres.length === 0;
  const malId = needsMal ? (anime.malId ?? await resolveMalId(anime.title)) : null;
  if (malId) {
    if (suggestions.length === 0) {
      try {
        const data = await fetchJson(`${JIKAN}/anime/${malId}/recommendations`);
        const items = (data?.data || []).slice(0, 18).map((r: any) => jikanToAnime(r.entry)).filter(Boolean) as AnimeItem[];
        suggestions = dedupe(items, new Set(collection.map(c => c.id).concat(anime.id)));
      } catch (err) {
        console.warn('[catalogService] MyAnimeList recommendations failed:', err);
      }
    }
    if (!description || genres.length === 0) {
      try {
        const data = await fetchJson(`${JIKAN}/anime/${malId}`);
        const info = jikanToAnime(data?.data);
        description = description || info?.description;
        if (genres.length === 0) genres = info?.genres || [];
      } catch (err) {
        console.warn('[catalogService] MyAnimeList details failed:', err);
      }
    }
  }

  return { description, genres, collection: collection.length > 1 ? collection : [], suggestions };
}
