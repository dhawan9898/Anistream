// catalogService.ts - Genre browsing plus the "Collection" (other seasons /
// related entries) and "More Like This" (suggestions) rails on an anime's
// page, Netflix-style.
//
// Genres come from the streaming site itself (hianime.at's /genres/<name>
// listing pages, same card markup as search), falling back to AniList when
// the site gives nothing back. "More Like This" is similarity-ranked:
// AniList's per-title recommendations first, then site titles that share the
// most genres with this one - the site's own "Recommended" block is a
// generic list, so it's only a last resort. Entries that came from AniList
// carry an "al-" id and are matched to a real site entry by title
// (resolveAnime) before they can be played.
import {
  fetchSiteHtml,
  parseSearchResults,
  searchAnimeLive,
  sitePathOf,
  type AnimeItem
} from '../core/aniCliCore';
import { request } from '../core/http';

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
  // Other seasons/parts/movies of the same franchise. May include the anime
  // itself (same id) so the rail reads as a whole collection.
  collection: AnimeItem[];
  suggestions: AnimeItem[];
}

const GENRE_NAMES: [string, string][] = [
  ['action', 'Action'], ['adventure', 'Adventure'], ['cars', 'Cars'], ['comedy', 'Comedy'],
  ['dementia', 'Dementia'], ['demons', 'Demons'], ['drama', 'Drama'], ['ecchi', 'Ecchi'],
  ['fantasy', 'Fantasy'], ['game', 'Game'], ['harem', 'Harem'], ['historical', 'Historical'],
  ['horror', 'Horror'], ['isekai', 'Isekai'], ['josei', 'Josei'], ['kids', 'Kids'],
  ['magic', 'Magic'], ['martial-arts', 'Martial Arts'], ['mecha', 'Mecha'], ['military', 'Military'],
  ['music', 'Music'], ['mystery', 'Mystery'], ['parody', 'Parody'], ['police', 'Police'],
  ['psychological', 'Psychological'], ['romance', 'Romance'], ['samurai', 'Samurai'], ['school', 'School'],
  ['sci-fi', 'Sci-Fi'], ['seinen', 'Seinen'], ['shoujo', 'Shoujo'], ['shoujo-ai', 'Shoujo Ai'],
  ['shounen', 'Shounen'], ['shounen-ai', 'Shounen Ai'], ['slice-of-life', 'Slice of Life'], ['space', 'Space'],
  ['sports', 'Sports'], ['super-power', 'Super Power'], ['supernatural', 'Supernatural'], ['thriller', 'Thriller'],
  ['vampire', 'Vampire']
];

export const DEFAULT_GENRES: Genre[] = GENRE_NAMES.map(([slug, name]) => ({ slug, name, path: `/genres/${slug}` }));

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------ AniList

const ANILIST = 'https://graphql.anilist.co';

async function anilist(query: string, variables: Record<string, unknown>): Promise<any> {
  // A GraphQL read is safe to retry; AniList answers 429 when rate limited,
  // which request() backs off from (honoring Retry-After).
  const res = await request(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  }, { timeoutMs: 10000, retries: 2 });
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message}`);
  return json.data;
}

const MEDIA_FIELDS = `id format episodes genres synonyms
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

function anilistToAnime(m: any): AnimeItem | null {
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
    type: FORMAT_LABELS[m.format] || undefined,
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
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    absolute = new URL(href, `https://hianime.at${currentPath}`);
  } catch {
    return undefined;
  }
  const path = sitePathOf(absolute.toString());
  if (!path || path + absolute.search === currentPath) return undefined;
  return path + absolute.search;
}

// ------------------------------------------------------------------ genres

let genresCache: Promise<Genre[]> | null = null;

// The site's own genre links (from its home page menu) when they can be
// read - so the paths are the site's real ones - otherwise the standard list
// under /genres/.
export function getGenres(): Promise<Genre[]> {
  if (!genresCache) {
    genresCache = (async () => {
      try {
        const html = await fetchSiteHtml('/home');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const found: Genre[] = [];
        const seen = new Set<string>();
        doc.querySelectorAll('a[href*="/genre"]').forEach(a => {
          const path = sitePathOf(a.getAttribute('href') || '').replace(/\/$/, '');
          if (!/^\/genres?\/[^/]+$/.test(path)) return;
          const slug = path.split('/').pop() || '';
          const name = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
          if (!slug || !name || name.length > 30 || seen.has(slug)) return;
          seen.add(slug);
          found.push({ slug, name, path });
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
    const items = (data?.Page?.media || []).map(anilistToAnime).filter(Boolean) as AnimeItem[];
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
  const titles = Array.from(new Set([anime.title, ...(anime.altTitles || [])]));
  for (const title of titles) {
    let results: AnimeItem[] = [];
    try {
      results = await searchAnimeLive(title);
    } catch (err) {
      console.warn('[catalogService] resolve search failed:', err);
      continue;
    }
    const best = results.find(r => normalizeTitle(r.title) === normalizeTitle(title))
      || results.find(r => titlesMatch(r.title, title));
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
    const match = results.find(r => r.id === anime.id);
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
  const title = (a.getAttribute('title') || a.getAttribute('data-jname') || a.textContent || '').trim();
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
}

export function parseDetailPage(html: string): ParsedDetailPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const description = (
    doc.querySelector('.film-description .text')?.textContent
    || doc.querySelector('.anisc-detail .film-description')?.textContent
    || ''
  ).trim() || undefined;

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

  return { description, genres, seasons, related: dedupe(related), recommended: dedupe(recommended) };
}

interface AniListInfo {
  description?: string;
  genres: string[];
  relations: AnimeItem[];
  recommendations: AnimeItem[];
  // Release-order sort key (year*12+month) per relation id.
  order: Map<string, number>;
  selfOrder?: number;
}

const RELATION_TYPES = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY']);

// How well an AniList entry's titles match the site title: 3 exact, 2
// prefix ("Title" vs "Title: Subtitle"), 1 same franchise, 0 unrelated.
function matchScore(media: any, title: string): number {
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
function goodRecommendations(media: any): AnimeItem[] {
  return (media?.recommendations?.nodes || [])
    .filter((n: any) => (n?.rating ?? 0) > 0 && n?.mediaRecommendation && !n.mediaRecommendation.isAdult)
    .map((n: any) => anilistToAnime(n.mediaRecommendation))
    .filter(Boolean) as AnimeItem[];
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
    const candidates: any[] = found?.Page?.media || [];
    let best: any = null;
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

    const dateKey = (m: any): number | undefined =>
      (m?.startDate?.year ? m.startDate.year * 12 + (m.startDate.month || 1) : undefined);
    const order = new Map<string, number>();
    const relations: AnimeItem[] = [];
    let root: any = null;
    for (const edge of media.relations?.edges || []) {
      if (edge?.node?.type !== 'ANIME' || !RELATION_TYPES.has(edge.relationType)) continue;
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
      selfOrder: dateKey(media)
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
  const pending = loadAnimeDetails(anime);
  detailsCache.set(anime.id, pending);
  // Don't pin a failed/empty lookup forever - let a later visit retry.
  pending.then(d => {
    if (d.collection.length === 0 && d.suggestions.length === 0) detailsCache.delete(anime.id);
  });
  return pending;
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

async function loadAnimeDetails(anime: AnimeItem): Promise<AnimeDetails> {
  const [parsed, aniList] = await Promise.all([loadSiteDetailPage(anime), loadAniListInfo(anime)]);

  const description = parsed.description || aniList?.description;
  const genres = parsed.genres.length ? parsed.genres : (aniList?.genres.length ? aniList.genres : (anime.genres || []));

  // Collection: the site's season switcher / related block (directly
  // playable), else AniList's relations in release order, else other site
  // titles sharing this franchise's base title.
  let collection = dedupe([...parsed.seasons, ...parsed.related]);
  if (collection.length <= 1 && aniList && aniList.relations.length > 0) {
    const order = new Map(aniList.order);
    if (aniList.selfOrder) order.set(anime.id, aniList.selfOrder);
    collection = dedupe([anime, ...aniList.relations])
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  }
  if (collection.length <= 1) {
    const key = franchiseKey(anime.title);
    if (key.length >= 3) {
      try {
        const results = await searchAnimeLive(key);
        const family = results.filter(r => franchiseKey(r.title) === key || normalizeTitle(r.title).startsWith(key));
        if (family.some(r => r.id !== anime.id)) collection = dedupe([anime, ...family]);
      } catch (err) {
        console.warn('[catalogService] Collection search failed:', err);
      }
    }
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

  return { description, genres, collection: collection.length > 1 ? collection : [], suggestions };
}
