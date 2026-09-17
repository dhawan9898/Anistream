// aniSkipService.ts - Resolves the real per-episode opening interval so
// "Skip Intro" can jump to where the intro actually ends, instead of a
// guessed, one-size-fits-all timestamp. ani-cli/hianime carry no chapter
// metadata of their own, so this looks the anime up on MyAnimeList (via the
// Jikan API) to get a MAL id, then asks the AniSkip API - a community
// database built for exactly this - for that episode's opening timestamps.

export interface SkipInterval {
  start: number;
  end: number;
}

const FETCH_TIMEOUT_MS = 6000;

// Title -> MAL id (or null if not found), so a multi-episode binge only
// pays for the MAL lookup once.
const malIdCache = new Map<string, number | null>();

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveMalId(title: string): Promise<number | null> {
  const cacheKey = title.trim().toLowerCase();
  if (malIdCache.has(cacheKey)) return malIdCache.get(cacheKey)!;

  try {
    const res = await fetchWithTimeout(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`);
    if (!res.ok) throw new Error(`Jikan lookup failed (${res.status})`);
    const data = await res.json();
    const malId: number | null = typeof data?.data?.[0]?.mal_id === 'number' ? data.data[0].mal_id : null;
    malIdCache.set(cacheKey, malId);
    return malId;
  } catch (err) {
    console.warn('[aniSkipService] MAL id lookup failed:', err);
    malIdCache.set(cacheKey, null);
    return null;
  }
}

// Returns the opening's [start, end] in seconds for this exact anime +
// episode, or null when no real data exists - callers should treat null as
// "don't offer to skip" rather than falling back to a guess.
export async function getOpeningSkipInterval(
  title: string,
  episodeNumber: string,
  episodeLengthSeconds: number
): Promise<SkipInterval | null> {
  const epNum = parseInt(episodeNumber, 10);
  if (!title || !isFinite(epNum) || epNum <= 0 || !episodeLengthSeconds || episodeLengthSeconds <= 0) {
    return null;
  }

  const malId = await resolveMalId(title);
  if (!malId) return null;

  try {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${epNum}?types[]=op&episodeLength=${Math.round(episodeLengthSeconds)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`AniSkip lookup failed (${res.status})`);
    const data = await res.json();
    const opResult = (data?.results || []).find((r: any) => r?.skipType === 'op');
    const interval = opResult?.interval;

    if (!interval || typeof interval.startTime !== 'number' || typeof interval.endTime !== 'number' || interval.endTime <= interval.startTime) {
      return null;
    }
    return { start: interval.startTime, end: interval.endTime };
  } catch (err) {
    console.warn('[aniSkipService] Skip-time lookup failed:', err);
    return null;
  }
}
