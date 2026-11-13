// seasonService.ts - The TV seasons of a show, from AniList's PREQUEL / SEQUEL links.
//
// A "season" here is what Netflix shows in its season picker: the main TV run of one show, split
// into the entries it aired as. It is never a movie, OVA, special, recap or spin-off - AniList types
// those (format MOVIE / OVA / SPECIAL, or relation SIDE_STORY / SPIN_OFF / SUMMARY ...), so only TV
// entries reached through PREQUEL / SEQUEL links count.
//
// Long-running shows (40+ episodes in one entry, e.g. Naruto, One Piece) are not split into seasons:
// they are their own show and get story arcs instead (arcService), so a title page never shows both.

/** One entry is "long-running" (arcs, not seasons) from this many episodes. */
export const LONG_RUNNING_EPISODES = 40;
const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const SEASON_LINKS = new Set(['PREQUEL', 'SEQUEL']);
const MAX_SEASONS = 20;

/** What the walk needs to know about an AniList entry. */
export interface SeasonMedia {
  id: number;
  format?: string | null;
  episodes?: number | null;
  // NOT_YET_RELEASED entries are not on the streaming site yet.
  status?: string | null;
  // For a show still airing, `episodes` is unknown; the next episode's number says how far it is.
  nextAiringEpisode?: { episode?: number | null } | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  relations?: { edges?: { relationType?: string | null; node?: SeasonMedia | null }[] | null } | null;
}

/** Episodes of an entry so far: its total, or for one still airing, the episodes already out. */
export function episodesSoFar(m: SeasonMedia): number | undefined {
  if (typeof m.episodes === 'number') return m.episodes;
  const next = m.nextAiringEpisode?.episode;
  return typeof next === 'number' ? Math.max(0, next - 1) : undefined;
}

const isLong = (m: SeasonMedia) => (episodesSoFar(m) ?? 0) >= LONG_RUNNING_EPISODES;
// A season is a released TV run of more than one episode: not a one-off special filed as TV / ONA,
// not a long-running show, and not something announced but not out yet.
const isSeasonEntry = (m: SeasonMedia | null | undefined): m is SeasonMedia =>
  !!m && SEASON_FORMATS.has(m.format || '') && !isLong(m) && m.episodes !== 1
  && m.status !== 'NOT_YET_RELEASED' && m.status !== 'CANCELLED';
// What may stand between two seasons in a sequel chain without being one.
const BRIDGE_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA', 'SPECIAL', 'OVA', 'MOVIE']);
const isBridge = (m: SeasonMedia) => BRIDGE_FORMATS.has(m.format || '') && !isLong(m) && m.status !== 'NOT_YET_RELEASED';
const startKey = (m: SeasonMedia) =>
  ((m.startDate?.year ?? 9999) * 12 + (m.startDate?.month ?? 12)) * 31 + (m.startDate?.day ?? 31);

/**
 * The seasons [start] belongs to, oldest first, including [start] itself - or [] when there is
 * nothing to pick between (a movie, a long-running show, or a single season). [fetchMedia] loads an
 * entry with its relations; every entry is fetched at most once.
 */
export async function walkSeasons(
  start: SeasonMedia,
  fetchMedia: (id: number) => Promise<SeasonMedia | null>
): Promise<SeasonMedia[]> {
  if (!isSeasonEntry(start)) return [];
  const found = new Map<number, SeasonMedia>([[start.id, start]]);
  const visited = new Set<number>([start.id]);
  // `bridged`: reached through a non-season entry (see below), which may not chain into another one.
  const queue: { media: SeasonMedia; bridged: boolean }[] = [{ media: start, bridged: false }];
  while (queue.length > 0 && found.size < MAX_SEASONS && visited.size < MAX_SEASONS * 2) {
    const { media: current, bridged } = queue.shift()!;
    for (const edge of current.relations?.edges ?? []) {
      const node = edge?.node;
      if (!node || !edge?.relationType || !SEASON_LINKS.has(edge.relationType) || visited.has(node.id)) continue;
      const season = isSeasonEntry(node);
      // A one-off special, OVA or movie can sit between two seasons in the sequel chain (Dr. Stone's
      // "Ryusui" special between Stone Wars and New World): walk through one, never list it.
      if (!season && (bridged || !isBridge(node))) continue;
      visited.add(node.id);
      // The edge only carries a summary of the entry; its own links come with the full record.
      const full = await fetchMedia(node.id);
      if (!full) continue;
      if (season && isSeasonEntry(full)) {
        found.set(full.id, full);
        queue.push({ media: full, bridged: false });
      } else if (!season && !bridged) {
        queue.push({ media: full, bridged: true });
      }
    }
  }
  const seasons = [...found.values()].sort((a, b) => startKey(a) - startKey(b) || a.id - b.id);
  return seasons.length >= 2 ? seasons : [];
}

/**
 * Picker labels for seasons in order, from their titles: "Season 3 Part 2", "Final Season",
 * "Final Season Part 2". Titles that say nothing about it ("BLEACH: Thousand-Year Blood War -
 * The Separation") are numbered by position, carrying on from the last numbered season.
 */
export function seasonLabels(titles: string[]): string[] {
  let lastNumber = 0;
  const labels = titles.map((raw, i) => {
    const t = raw.toLowerCase();
    const n = Number(t.match(/\bseason\s*(\d+)/)?.[1] ?? t.match(/\b(\d+)(?:st|nd|rd|th)\s+season/)?.[1] ?? NaN);
    const part = t.match(/\b(?:part|cour)\s*(\d+)/)?.[1];
    const final = /\bfinal season\b|\bthe final\b/.test(t);
    const partText = part ? ` Part ${part}` : '';
    if (final) return `Final Season${partText}`;
    if (!Number.isNaN(n)) {
      lastNumber = n;
      return `Season ${n}${partText}`;
    }
    // A later part of the season before it ("... Part 2" with no season number).
    if (part && i > 0 && part !== '1') return `Season ${Math.max(1, lastNumber)}${partText}`;
    lastNumber += 1;
    return `Season ${lastNumber}${partText}`;
  });
  // Never two identical entries in the picker.
  const seen = new Map<string, number>();
  return labels.map(l => {
    const count = (seen.get(l) ?? 0) + 1;
    seen.set(l, count);
    return count > 1 ? `${l} (${count})` : l;
  });
}
