// catalogService.ts - Genre browsing plus the "Collection" (other seasons /
// related entries) and "More Like This" (suggestions) rails on an anime's
// page, Netflix-style.
//
// Genres come from the streaming site itself (hianimes.se's /genres/<name>
// listing pages, same card markup as search), falling back to AniList when
// the site gives nothing back. "More Like This" is similarity-ranked:
// AniList's per-title recommendations first, then site titles that share the
// most genres with this one - the site's own "Recommended" block is a
// generic list, so it's only a last resort. Entries that came from AniList
// carry an "al-" id and are matched to a real site entry by title
// (resolveAnime) before they can be played.
import {
  decodeHtmlEntities,
  fetchSiteHtml,
  parseSearchResults,
  searchAnimeLive,
  sitePathOf,
  REMOTE_HOST,
  type AnimeItem
} from './aniCliCore';
import { request } from 'streamkit/core/http.ts';
import { seasonLabels, walkSeasons, type SeasonMedia } from './seasonService.ts';
import { readPersistedJson, writePersistedJson } from '../services/persistentCache.ts';

export interface Genre {
  slug: string;
  name: string;
  // Site path of the genre's listing page, e.g. "/genres/action".
  path: string;
}

export interface GenrePage {
  items: AnimeItem[];
  // Site path of the next page when the site links one; undefined when the
  // listing is exhausted (or came from AniList, which pages by number).
  nextPath?: string;
  hasMore: boolean;
}

export interface AnimeDetails {
  description?: string;
  genres: string[];
  // The rest of the franchise, Netflix style: movies, OVAs, specials, spin-offs and separate shows.
  // Never this title itself and never one of its seasons (those are in the season picker).
  collection: AnimeItem[];
  // The franchise's TV seasons in watch order (only when there are two or more), each carrying a
  // seasonLabel. Drives the season switcher on the episode list.
  seasons: AnimeItem[];
  suggestions: AnimeItem[];
}

const GENRE_NAMES: [string, string][] = [
  ['action', 'Action'],
  ['adventure', 'Adventure'],
  ['comedy', 'Comedy'],
  ['drama', 'Drama'],
  ['fantasy', 'Fantasy'],
  ['isekai', 'Isekai'],
  ['mystery', 'Mystery'],
  ['romance', 'Romance'],
  ['sci-fi', 'Sci-Fi'],
  ['shounen', 'Shounen'],
  ['slice-of-life', 'Slice of Life'],
  ['sports', 'Sports'],
  ['supernatural', 'Supernatural'],
  ['thriller', 'Thriller']
];

export const DEFAULT_GENRES: Genre[] = GENRE_NAMES.map(([slug, name]) => ({ slug, name, path: `/genres/${slug}` }));

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------ AniList

const ANILIST = 'https://graphql.anilist.co';


// ---- AniList wire shapes (only the fields this app reads) ----
interface AniListMedia {
  id: number;
  type?: string;
  format?: string;
  episodes?: number | null;
  status?: string | null;
  nextAiringEpisode?: { episode?: number | null } | null;
  genres?: string[] | null;
  synonyms?: string[] | null;
  title?: { romaji?: string | null; english?: string | null } | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  startDate?: { year?: number | null; month?: number | null } | null;
  description?: string | null;
  isAdult?: boolean;
  relations?: { edges?: AniListRelationEdge[] | null } | null;
  recommendations?: { nodes?: AniListRecNode[] | null } | null;
}
interface AniListRelationEdge { relationType?: string; node?: AniListMedia | null }
interface AniListRecNode { rating?: number | null; mediaRecommendation?: AniListMedia | null }
interface AniListData {
  Page?: { pageInfo?: { hasNextPage?: boolean | null } | null; media?: AniListMedia[] | null } | null;
  Media?: AniListMedia | null;
}

async function anilist(query: string, variables: Record<string, unknown>): Promise<AniListData | undefined> {
  // A GraphQL read is safe to retry; AniList answers 429 when rate limited,
  // which request() backs off from (honoring Retry-After).
  const res = await request(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  }, { timeoutMs: 10000, retries: 2 });
  const json = (await res.json()) as { data?: AniListData; errors?: { message?: string }[] } | null;
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message}`);
  return json?.data;
}

const MEDIA_FIELDS = `id format episodes status nextAiringEpisode { episode } genres synonyms
  title { romaji english }
  coverImage { extraLarge large }
  startDate { year month }
  description(asHtml: false)`;

const FORMAT_LABELS: Record<string, string> = {
  TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music'
};

function stripHtml(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim() || undefined;
}

function anilistToAnime(m: AniListMedia | null | undefined): AnimeItem | null {
  if (!m || typeof m.id !== 'number') return null;
  const title = m.title?.english || m.title?.romaji || '';
  const poster = m.coverImage?.extraLarge || m.coverImage?.large || '';
  if (!title || !poster) return null;
  const altTitles = [m.title?.romaji, m.title?.english, ...(m.synonyms || [])]
    .filter((t: unknown): t is string => typeof t === 'string' && !!t && t !== title);
  return {
    id: `al-${m.id}`,
    title,
    altTitles,
    poster,
    type: (m.format && FORMAT_LABELS[m.format]) || undefined,
    subCount: typeof m.episodes === 'number' ? m.episodes : undefined,
    description: stripHtml(m.description),
    genres: Array.isArray(m.genres) ? m.genres : undefined
  };
}

// AniList splits hianime's genres into real genres and tags.
const ANILIST_GENRES = new Set(['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror',
  'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
  'Sports', 'Supernatural', 'Thriller']);
const ANILIST_TAG_OVERRIDES: Record<string, string | null> = {
  harem: 'Female Harem', game: 'Video Games', 'shoujo-ai': 'Yuri', 'shounen-ai': "Boys' Love",
  dementia: null
};

function anilistFilterFor(genre: Genre): { genre?: string; tag?: string } | null {
  const known = GENRE_NAMES.find(([slug]) => slug === genre.slug);
  const name = known ? known[1] : genre.name;
  if (ANILIST_GENRES.has(name)) return { genre: name };
  if (genre.slug in ANILIST_TAG_OVERRIDES) {
    const tag = ANILIST_TAG_OVERRIDES[genre.slug];
    return tag ? { tag } : null;
  }
  return { tag: name };
}

// --------------------------------------------------------------- helpers

function dedupe(items: AnimeItem[], exclude: Set<string> = new Set()): AnimeItem[] {
  const seen = new Set(exclude);
  return items.filter(item => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeTitle(title: string): string {
  return decodeHtmlEntities(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x));
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

// Next-page link as the site itself renders it (?page=N or /page/N/),
// so pagination follows whatever scheme hianime.at really uses. Relative
// links ("?page=2") resolve against the listing's own path.
function findNextPagePath(doc: Document, page: number, currentPath: string): string | undefined {
  const next = page + 1;
  const links = Array.from(doc.querySelectorAll('a[href]'));
  const pattern = new RegExp(`([?&]page=${next}(&|$))|(/page/${next}/?$)`);
  const byNumber = links.find(a => pattern.test(a.getAttribute('href') || ''));
  const byRel = links.find(a => /\bnext\b/i.test(`${a.getAttribute('rel') || ''} ${a.getAttribute('title') || ''} ${a.className}`));
  const href = (byNumber || byRel)?.getAttribute('href');
  if (!href) return undefined;
  let absolute: URL;
  try {
    absolute = new URL(href, `${REMOTE_HOST}${currentPath}`);
  } catch {
    return undefined;
  }
  const path = sitePathOf(absolute.toString());
  if (!path || path + absolute.search === currentPath) return undefined;
  return path + absolute.search;
}

// ------------------------------------------------------------------ genres

let genresCache: Promise<Genre[]> | null = null;

// Returns the clean, curated list of essential anime categories under /genres/.
export function getGenres(): Promise<Genre[]> {
  if (!genresCache) {
    genresCache = Promise.resolve(DEFAULT_GENRES);
  }
  return genresCache;
}

export async function findGenre(name: string): Promise<Genre | undefined> {
  const all = await getGenres();
  const slug = slugify(name);
  return all.find(g => g.slug === slug || g.name.toLowerCase() === name.toLowerCase())
    || DEFAULT_GENRES.find(g => g.slug === slug);
}

const genrePageCache = new Map<string, Promise<GenrePage>>();

// One page of a genre's listing. `page` is 1-based; for page > 1 pass the
// previous page's nextPath so the site's own pagination links are followed.
// Cached for the session so backing out of a title doesn't refetch.
export function getAnimeByGenre(genre: Genre, page = 1, nextPath?: string): Promise<GenrePage> {
  const key = `${genre.path}#${page}`;
  const cached = genrePageCache.get(key);
  if (cached) return cached;
  const pending = loadGenrePage(genre, page, nextPath);
  genrePageCache.set(key, pending);
  pending.then(result => {
    if (result.items.length === 0) genrePageCache.delete(key);
  });
  return pending;
}

async function loadGenrePage(genre: Genre, page: number, nextPath?: string): Promise<GenrePage> {
  // Page 1 always tries the site; later pages come from the site only when
  // it linked them (otherwise the listing is AniList's, paged by number).
  if (page === 1 || nextPath) {
    try {
      const pagePath = page === 1 ? genre.path : nextPath!;
      const html = await fetchSiteHtml(pagePath);
      const items = parseSearchResults(html);
      if (items.length > 0) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const next = findNextPagePath(doc, page, pagePath);
        return { items, nextPath: next, hasMore: !!next };
      }
      console.warn(`[catalogService] Genre page ${genre.path} had no parseable titles, using AniList`);
    } catch (err) {
      console.warn(`[catalogService] Genre page ${genre.path} failed, using AniList:`, err);
    }
    if (page > 1) return { items: [], hasMore: false };
  }

  const filter = anilistFilterFor(genre);
  if (!filter) return { items: [], hasMore: false };
  try {
    const data = await anilist(`query ($page: Int, $genre: String, $tag: String) {
      Page(page: $page, perPage: 24) {
        pageInfo { hasNextPage }
        media(type: ANIME, isAdult: false, sort: POPULARITY_DESC, genre: $genre, tag: $tag) { ${MEDIA_FIELDS} }
      }
    }`, { page, ...filter });
    const items = (data?.Page?.media || []).map(anilistToAnime).filter((a): a is AnimeItem => a !== null);
    return { items: dedupe(items), hasMore: !!data?.Page?.pageInfo?.hasNextPage };
  } catch (err) {
    console.warn('[catalogService] AniList genre lookup failed:', err);
    return { items: [], hasMore: false };
  }
}

// --------------------------------------------------------- title matching

// AniList-backed entries ("al-" ids) have no streaming-site id yet - search
// the site under each of the entry's known titles and adopt a result whose
// title actually matches. Never falls back to an unrelated first result:
// throws if nothing matches. Site entries are returned as-is.
export async function resolveAnime(anime: AnimeItem): Promise<AnimeItem> {
  if (!anime.id.startsWith('al-') && !anime.id.startsWith('mal-')) return anime;
  try {
    const resolved = await resolveFromSite(anime);
    writePersistedJson(`resolved:${anime.id}`, resolved);
    return resolved;
  } catch (err) {
    // Offline (or the site is down): the match found on an earlier visit.
    const saved = await readPersistedJson<AnimeItem>(`resolved:${anime.id}`);
    if (saved) return saved.value;
    throw err;
  }
}

// "season 2" / "2nd season" / "part 2" / a trailing number, as one comparable key ("" for none).
export function seasonMarker(title: string): string {
  const t = normalizeTitle(title);
  const season = t.match(/\bseason (\d+)/)?.[1] ?? t.match(/\b(\d+)(?:st|nd|rd|th) season/)?.[1]
    ?? t.match(/\b(ii|iii|iv|v|\d)$/)?.[1] ?? '';
  const part = t.match(/\b(?:part|cour) (\d+)/)?.[1] ?? '';
  const roman: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5' };
  const n = roman[season] ?? season;
  return `${n === '1' ? '' : n}|${part === '1' ? '' : part}`;
}

async function resolveFromSite(anime: AnimeItem): Promise<AnimeItem> {
  const titles = Array.from(new Set([anime.title, ...(anime.altTitles || [])]));
  for (const title of titles) {
    let results: AnimeItem[] = [];
    try {
      results = await searchAnimeLive(title);
    } catch (err) {
      console.warn('[catalogService] resolve search failed:', err);
      continue;
    }
    // Exact title first; a looser match must at least be the same season and kind ("Solo Leveling"
    // is a prefix of "Solo Leveling Season 2", but it is not that season).
    const best = results.find(r => normalizeTitle(r.title) === normalizeTitle(title))
      || results.find(r => titlesMatch(r.title, title) && seasonMarker(r.title) === seasonMarker(title)
        && (!anime.type || !r.type || anime.type === r.type));
    if (best) {
      return {
        ...best,
        description: best.description || anime.description,
        genres: best.genres || anime.genres
      };
    }
  }
  throw new Error(`"${anime.title}" was not found on the streaming site`);
}

// ------------------------------------------------------------ dub support

const dubCache = new Map<string, boolean | undefined>();

// Whether a title has an English dub: true/false when known, undefined when
// it can't be told (the caller then keeps the option available). Entries
// from the site's own lists carry the answer; others (opened from history,
// AniList suggestions) are looked up once by title.
export async function hasDub(anime: AnimeItem): Promise<boolean | undefined> {
  if (anime.dubCount !== undefined) return anime.dubCount > 0;
  if (dubCache.has(anime.id)) return dubCache.get(anime.id);
  try {
    const results = await searchAnimeLive(anime.title);
    const match = results.find(r => r.id === anime.id) || results.find(r => titlesMatch(r.title, anime.title));
    const known = match && match.dubCount !== undefined ? match.dubCount > 0 : undefined;
    dubCache.set(anime.id, known);
    return known;
  } catch {
    return undefined;
  }
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
  const rawTitle = a.getAttribute('title') || a.getAttribute('data-jname') || a.textContent || '';
  const title = decodeHtmlEntities(rawTitle).trim();
  const poster = posterOf(container);
  if (!id || !title || id === 'home' || /^\/genres?\//.test(path)) return null;
  return { id, path, title, poster, seasonLabel: label, type: 'TV' };
}

interface ParsedDetailPage {
  description?: string;
  genres: string[];
  seasons: AnimeItem[];
  related: AnimeItem[];
  recommended: AnimeItem[];
  subCount?: number;
  dubCount?: number;
  episodesCount?: number;
}

export function parseDetailPage(html: string): ParsedDetailPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const description = (
    doc.querySelector('.film-description .text')?.textContent
    || doc.querySelector('.anisc-detail .film-description')?.textContent
    || ''
  ).trim() || undefined;

  const subBadge = doc.querySelector('.tick-sub')?.textContent?.trim();
  const dubBadge = doc.querySelector('.tick-dub')?.textContent?.trim();
  const epBadge = doc.querySelector('.tick-eps')?.textContent?.trim();
  const subCount = subBadge ? parseInt(subBadge, 10) : undefined;
  const dubCount = dubBadge ? parseInt(dubBadge, 10) : undefined;
  const episodesCount = epBadge ? parseInt(epBadge, 10) : undefined;

  // Genre links in the title's own info block (never the site-wide menu).
  const infoGenreLinks = doc.querySelectorAll(
    '.anisc-info a[href*="/genre"], .anisc-detail a[href*="/genre"], .film-stats a[href*="/genre"]'
  );
  const genres = Array.from(new Set(
    Array.from(infoGenreLinks)
      .map(a => (a.getAttribute('title') || a.textContent || '').trim())
      .filter(g => g && g.length <= 30)
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

  return { description, genres, seasons, related: dedupe(related), recommended: dedupe(recommended), subCount, dubCount, episodesCount };
}

interface AniListInfo {
  description?: string;
  genres: string[];
  relations: AnimeItem[];
  recommendations: AnimeItem[];
  // Release-order sort key (year*12+month) per relation id.
  order: Map<string, number>;
  selfOrder?: number;
  // The matched entry itself, with its relations (the start of the season walk).
  self: AniListMedia;
}

const RELATION_TYPES = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY']);

// How well an AniList entry's titles match the site title: 3 exact, 2
// prefix ("Title" vs "Title: Subtitle"), 1 same franchise, 0 unrelated.
function matchScore(media: AniListMedia | null | undefined, title: string): number {
  const names = [media?.title?.english, media?.title?.romaji, ...(media?.synonyms || [])]
    .filter((t: unknown): t is string => typeof t === 'string' && !!t);
  const wanted = normalizeTitle(title);
  if (names.some(n => normalizeTitle(n) === wanted)) return 3;
  if (names.some(n => titlesMatch(n, title))) return 2;
  if (names.some(n => franchiseKey(n) === franchiseKey(title))) return 1;
  return 0;
}

const REC_FIELDS = `recommendations(sort: RATING_DESC, perPage: 25) {
  nodes { rating mediaRecommendation { isAdult ${MEDIA_FIELDS} } }
}`;

// Community recommendations with a positive rating, best first, minus adult
// titles - the votes are what make "More Like This" actually similar.
function goodRecommendations(media: AniListMedia | null | undefined): AnimeItem[] {
  return (media?.recommendations?.nodes || [])
    .filter(n => (n?.rating ?? 0) > 0 && n?.mediaRecommendation && !n.mediaRecommendation.isAdult)
    .map(n => anilistToAnime(n.mediaRecommendation))
    .filter((a): a is AnimeItem => a !== null);
}

// A sequel ("Season 3") rarely has many recommendations of its own; below
// this many, the franchise's root entry's recommendations are added.
const MIN_OWN_RECOMMENDATIONS = 8;

async function loadAniListInfo(anime: AnimeItem): Promise<AniListInfo | null> {
  try {
    // 1. Find the entry: AniList's search is fuzzy, so look at the top few
    //    results and take the best title match - never an unrelated one.
    const found = await anilist(`query ($search: String) {
      Page(perPage: 6) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id synonyms title { romaji english } } }
    }`, { search: anime.title });
    const candidates: AniListMedia[] = found?.Page?.media || [];
    let best: AniListMedia | null = null;
    let bestScore = 0;
    for (const m of candidates) {
      const score = matchScore(m, anime.title);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    if (!best) {
      console.warn(`[catalogService] No AniList entry matches "${anime.title}"`);
      return null;
    }

    // 2. Full details for that exact entry.
    const data = await anilist(`query ($id: Int) {
      Media(id: $id, type: ANIME) {
        ${MEDIA_FIELDS}
        relations { edges { relationType node { id type ${MEDIA_FIELDS} } } }
        ${REC_FIELDS}
      }
    }`, { id: best.id });
    const media = data?.Media;
    if (!media) return null;

    const dateKey = (m: AniListMedia | null | undefined): number | undefined =>
      (m?.startDate?.year ? m.startDate.year * 12 + (m.startDate.month || 1) : undefined);
    const order = new Map<string, number>();
    const relations: AnimeItem[] = [];
    let root: AniListMedia | null = null;
    for (const edge of media.relations?.edges || []) {
      if (edge?.node?.type !== 'ANIME' || !edge.relationType || !RELATION_TYPES.has(edge.relationType)) continue;
      if (!root && (edge.relationType === 'PARENT' || edge.relationType === 'PREQUEL')) root = edge.node;
      const item = anilistToAnime(edge.node);
      if (!item) continue;
      relations.push(item);
      const key = dateKey(edge.node);
      if (key) order.set(item.id, key);
    }

    // 3. Sparse recommendations (typical for sequels): add the parent /
    //    prequel's, which describe the same show.
    let recommendations = goodRecommendations(media);
    if (recommendations.length < MIN_OWN_RECOMMENDATIONS && root?.id) {
      try {
        const rootData = await anilist(`query ($id: Int) { Media(id: $id, type: ANIME) { id ${REC_FIELDS} } }`, { id: root.id });
        recommendations = dedupe([...recommendations, ...goodRecommendations(rootData?.Media)]);
      } catch (err) {
        console.warn('[catalogService] Franchise recommendations failed:', err);
      }
    }

    return {
      description: stripHtml(media.description),
      genres: Array.isArray(media.genres) ? media.genres : [],
      relations,
      recommendations,
      order,
      selfOrder: dateKey(media),
      self: media
    };
  } catch (err) {
    console.warn('[catalogService] AniList lookup failed:', err);
    return null;
  }
}

// Site titles sharing the most genres with this one: the first page of each
// of its genres (up to three), scored by how many of those lists a title
// appears in, then by its best rank within them.
async function suggestByGenres(genreNames: string[], exclude: Set<string>): Promise<AnimeItem[]> {
  const genres = (await Promise.all(genreNames.slice(0, 3).map(findGenre))).filter(Boolean) as Genre[];
  if (genres.length === 0) return [];
  const pages = await Promise.all(genres.map(g => getAnimeByGenre(g, 1)));
  const scores = new Map<string, { item: AnimeItem; hits: number; rank: number }>();
  pages.forEach(page => page.items.forEach((item, rank) => {
    if (exclude.has(item.id)) return;
    const entry = scores.get(item.id);
    if (entry) {
      entry.hits += 1;
      entry.rank = Math.min(entry.rank, rank);
    } else {
      scores.set(item.id, { item, hits: 1, rank });
    }
  }));
  return Array.from(scores.values())
    .sort((a, b) => b.hits - a.hits || a.rank - b.rank)
    .slice(0, 18)
    .map(s => s.item);
}

const detailsCache = new Map<string, Promise<AnimeDetails>>();

export function getAnimeDetails(anime: AnimeItem): Promise<AnimeDetails> {
  const cached = detailsCache.get(anime.id);
  if (cached) return cached;
  const pending = loadDetailsOrSaved(anime);
  detailsCache.set(anime.id, pending);
  // Don't pin a failed/empty lookup forever - let a later visit retry.
  pending.then(d => {
    if (d.collection.length === 0 && d.suggestions.length === 0) detailsCache.delete(anime.id);
  });
  return pending;
}

// Title details are kept on disk after every successful load; when nothing
// useful can be loaded (offline), the copy from the last visit is shown.
async function loadDetailsOrSaved(anime: AnimeItem): Promise<AnimeDetails> {
  // v3: seasons from AniList only, and kept out of the collection; older copies differ.
  const key = `details3:${anime.id}`;
  let fresh: AnimeDetails;
  try {
    fresh = await loadAnimeDetails(anime);
  } catch (err) {
    const saved = await readPersistedJson<AnimeDetails>(key);
    if (saved) return saved.value;
    throw err;
  }
  const hasContent = !!fresh.description || fresh.collection.length > 0 || fresh.suggestions.length > 0 || fresh.genres.length > 0;
  if (hasContent) {
    writePersistedJson(key, fresh);
    return fresh;
  }
  const saved = await readPersistedJson<AnimeDetails>(key);
  return saved ? saved.value : fresh;
}

async function loadSiteDetailPage(anime: AnimeItem): Promise<ParsedDetailPage> {
  const candidates = Array.from(new Set([anime.path, `/${anime.id}`].filter(Boolean) as string[]));
  for (const path of candidates) {
    try {
      return parseDetailPage(await fetchSiteHtml(path));
    } catch (err) {
      console.warn(`[catalogService] Detail page ${path} failed:`, err);
    }
  }
  return { genres: [], seasons: [], related: [], recommended: [] };
}

// One AniList entry with its relations, for the season walk (memory-cached per session). Each
// request also brings the relations of the entries it links to, which are cached as well, so a show
// with eight seasons takes three or four requests instead of eight (AniList rate-limits hard).
const seasonMediaCache = new Map<number, Promise<AniListMedia | null>>();
const LINK_FIELDS = 'id type format episodes status nextAiringEpisode { episode } startDate { year month day }';
function fetchSeasonMedia(id: number): Promise<AniListMedia | null> {
  const hit = seasonMediaCache.get(id);
  if (hit) return hit;
  const pending = anilist(`query ($id: Int) {
    Media(id: $id, type: ANIME) {
      ${MEDIA_FIELDS}
      relations { edges { relationType node {
        ${LINK_FIELDS} synonyms title { romaji english } coverImage { extraLarge large }
        relations { edges { relationType node { ${LINK_FIELDS} } } }
      } } }
    }
  }`, { id }).then(d => {
    const media = d?.Media ?? null;
    for (const edge of media?.relations?.edges ?? []) {
      const node = edge?.node;
      // A linked entry arrives with its own links: good enough for the walk, so keep it.
      if (node && node.relations && !seasonMediaCache.has(node.id)) seasonMediaCache.set(node.id, Promise.resolve(node));
    }
    return media;
  });
  seasonMediaCache.set(id, pending);
  pending.catch(() => seasonMediaCache.delete(id));
  return pending;
}

/**
 * The show's seasons as playable items labelled "Season N", from AniList's sequel links (see
 * seasonService). Each is the site's own entry when one with exactly that title is known, else an
 * AniList item the detail page matches to the site when opened. [] when there is no season picker.
 */
async function loadSeasons(
  anime: AnimeItem,
  self: AniListMedia,
  siteItems: AnimeItem[]
): Promise<{ seasons: AnimeItem[]; names: Set<string> }> {
  const chain = await walkSeasons(self as SeasonMedia, id => fetchSeasonMedia(id) as Promise<SeasonMedia | null>);
  // Every name a season goes by, so the collection can drop its copies of them.
  const names = new Set<string>();
  for (const entry of chain) {
    const m = entry as AniListMedia;
    [m.title?.english, m.title?.romaji, ...(m.synonyms || [])].forEach(t => { if (t) names.add(normalizeTitle(t)); });
  }
  const labels = seasonLabels(chain.map(e => {
    const m = e as AniListMedia;
    return m.title?.english || m.title?.romaji || '';
  }));
  // A site entry stands for one season only (a later part often lists the earlier title among its
  // synonyms), and its season / part marker must agree with the AniList entry's own title.
  const used = new Set<string>([anime.id]);
  const seasons = chain.map((entry, i) => {
    const media = entry as AniListMedia;
    const seasonLabel = labels[i];
    if (media.id === self.id) return { ...anime, seasonLabel };
    const ownTitle = media.title?.english || media.title?.romaji || '';
    const site = siteItems.find(c => !used.has(c.id) && matchScore(media, c.title) === 3
      && seasonMarker(c.title) === seasonMarker(ownTitle));
    if (site) {
      used.add(site.id);
      return { ...site, seasonLabel };
    }
    const fromAniList = anilistToAnime(media);
    const title = media.title?.english || media.title?.romaji || anime.title;
    return { ...(fromAniList ?? { id: `al-${media.id}`, title, poster: anime.poster, type: 'TV' }), seasonLabel };
  });
  // Never the same entry twice in the picker.
  return { seasons: dedupe(seasons), names };
}

async function loadAnimeDetails(anime: AnimeItem): Promise<AnimeDetails> {
  const [parsed, aniList] = await Promise.all([loadSiteDetailPage(anime), loadAniListInfo(anime)]);

  const description = parsed.description || aniList?.description;
  const genres = parsed.genres.length ? parsed.genres : (aniList?.genres.length ? aniList.genres : (anime.genres || []));
  if (parsed.dubCount !== undefined && anime.dubCount === undefined) {
    anime.dubCount = parsed.dubCount;
  }
  if (parsed.subCount !== undefined && anime.subCount === undefined) {
    anime.subCount = parsed.subCount;
  }

  // Collection: the site's season switcher / related block (directly
  // playable), else AniList's relations in release order, else other site
  // titles sharing this franchise's base title.
  // (The site's season switcher is not used here: those entries are seasons.)
  let collection = dedupe(parsed.related);
  if (collection.length <= 1 && aniList && aniList.relations.length > 0) {
    const order = new Map(aniList.order);
    if (aniList.selfOrder) order.set(anime.id, aniList.selfOrder);
    collection = dedupe([anime, ...aniList.relations])
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  }

  // Other site titles of the same franchise: a fallback for the collection, and candidates for
  // matching seasons to the site's own entries.
  let family: AnimeItem[] = [];
  const key = franchiseKey(anime.title);
  if (key.length >= 3 && (collection.length <= 1 || aniList)) {
    try {
      const results = await searchAnimeLive(key);
      family = results.filter(r => franchiseKey(r.title) === key || normalizeTitle(r.title).startsWith(key));
    } catch (err) {
      console.warn('[catalogService] Collection search failed:', err);
    }
  }
  if (collection.length <= 1 && family.some(r => r.id !== anime.id)) collection = dedupe([anime, ...family]);

  // Seasons come only from AniList's sequel links between TV entries - never from the site's
  // season switcher or title look-alikes, which mix in movies, recaps and spin-offs.
  let seasons: AnimeItem[] = [];
  let seasonNames = new Set<string>();
  if (aniList) {
    try {
      ({ seasons, names: seasonNames } = await loadSeasons(
        anime, aniList.self, dedupe([...parsed.seasons, ...parsed.related, ...family, ...collection])));
    } catch (err) {
      console.warn('[catalogService] Seasons unavailable:', err);
    }
  }
  if (seasons.length > 0) {
    // Seasons live in the season picker only.
    const seasonIds = new Set(seasons.map(x => x.id));
    collection = collection.filter(c => !seasonIds.has(c.id) && !seasonNames.has(normalizeTitle(c.title)));
  }

  // More Like This: real similarity first (AniList recommendations), then
  // the site's titles with the most genres in common.
  const exclude = new Set(collection.map(c => c.id).concat(anime.id));
  const franchise = franchiseKey(anime.title);
  const notSameShow = (s: AnimeItem) => franchiseKey(s.title) !== franchise;
  let suggestions = dedupe(aniList?.recommendations || [], exclude).filter(notSameShow).slice(0, 18);
  if (suggestions.length < 6 && genres.length > 0) {
    const byGenre = await suggestByGenres(genres, new Set([...exclude, ...suggestions.map(s => s.id)]));
    suggestions = dedupe([...suggestions, ...byGenre.filter(notSameShow)]).slice(0, 18);
  }
  if (suggestions.length === 0) {
    suggestions = dedupe(parsed.recommended, exclude).filter(notSameShow);
  }

  // Never the title itself (Netflix doesn't list what you are looking at).
  const selfName = normalizeTitle(anime.title);
  collection = collection.filter(c => c.id !== anime.id && normalizeTitle(c.title) !== selfName);
  return { description, genres, collection, seasons, suggestions };
}
