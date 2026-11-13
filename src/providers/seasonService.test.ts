import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkSeasons, seasonLabels, type SeasonMedia } from './seasonService.ts';

// Fixtures follow AniList's real data (checked against graphql.anilist.co).
type Link = [string, number];
function db(entries: Record<number, Omit<SeasonMedia, 'id' | 'relations'> & { links?: Link[] }>) {
  const all = new Map<number, SeasonMedia>();
  for (const [id, e] of Object.entries(entries)) all.set(Number(id), { id: Number(id), ...e });
  for (const [id, e] of Object.entries(entries)) {
    all.get(Number(id))!.relations = { edges: (e.links ?? []).map(([relationType, to]) => ({ relationType, node: all.get(to)! })) };
  }
  const fetchMedia = async (id: number) => all.get(id) ?? null;
  return { get: (id: number) => all.get(id)!, fetchMedia };
}
const ids = (list: SeasonMedia[]) => list.map(m => m.id);

test('Solo Leveling: two TV seasons, the recap movie is not one', async () => {
  const d = db({
    1: { format: 'TV', episodes: 12, startDate: { year: 2024 }, links: [['SEQUEL', 2], ['SUMMARY', 3]] },
    2: { format: 'TV', episodes: 13, startDate: { year: 2025 }, links: [['PREQUEL', 1]] },
    3: { format: 'MOVIE', episodes: 1, startDate: { year: 2024 }, links: [['SUMMARY', 1]] }
  });
  assert.deepEqual(ids(await walkSeasons(d.get(1), d.fetchMedia)), [1, 2]);
  assert.deepEqual(ids(await walkSeasons(d.get(2), d.fetchMedia)), [1, 2], 'same list from season 2');
});

test('One Punch Man: OVAs, side stories and an unreleased part are left out', async () => {
  const d = db({
    1: { format: 'TV', episodes: 12, startDate: { year: 2015 }, links: [['SEQUEL', 2], ['SIDE_STORY', 9], ['PREQUEL', 8]] },
    2: { format: 'TV', episodes: 12, startDate: { year: 2019 }, links: [['PREQUEL', 1], ['SEQUEL', 3]] },
    3: { format: 'TV', episodes: 12, startDate: { year: 2025 }, links: [['PREQUEL', 2], ['SEQUEL', 4]] },
    4: { format: 'TV', episodes: null, status: 'NOT_YET_RELEASED', startDate: { year: 2027 }, links: [['PREQUEL', 3]] },
    8: { format: 'OVA', episodes: 1, startDate: { year: 2015 }, links: [['SEQUEL', 1]] },
    9: { format: 'OVA', episodes: 6, startDate: { year: 2015 } }
  });
  assert.deepEqual(ids(await walkSeasons(d.get(1), d.fetchMedia)), [1, 2, 3]);
});

test('long-running shows get no seasons (they get arcs), even while airing', async () => {
  const d = db({
    20: { format: 'TV', episodes: 220, links: [['SEQUEL', 21]] },
    21: { format: 'TV', episodes: 500, links: [['PREQUEL', 20]] },
    // One Piece: still airing, so AniList has no episode total - only the next episode number.
    30: { format: 'TV', episodes: null, status: 'RELEASING', nextAiringEpisode: { episode: 1181 }, links: [['SEQUEL', 31]] },
    31: { format: 'ONA', episodes: 1, startDate: { year: 2024 }, links: [['PREQUEL', 30]] }
  });
  assert.deepEqual(await walkSeasons(d.get(20), d.fetchMedia), []);
  assert.deepEqual(await walkSeasons(d.get(30), d.fetchMedia), []);
});

test('Dr. Stone: the walk passes through a one-off special between two seasons', async () => {
  const d = db({
    1: { format: 'TV', episodes: 24, startDate: { year: 2019 }, links: [['SEQUEL', 2]] },
    2: { format: 'TV', episodes: 11, startDate: { year: 2021 }, links: [['PREQUEL', 1], ['SEQUEL', 3]] },
    3: { format: 'TV_SHORT', episodes: 1, startDate: { year: 2022, month: 7 }, links: [['PREQUEL', 2], ['SEQUEL', 4]] },
    4: { format: 'TV', episodes: 11, startDate: { year: 2023 }, links: [['PREQUEL', 3]] }
  });
  assert.deepEqual(ids(await walkSeasons(d.get(1), d.fetchMedia)), [1, 2, 4]);
});

test('a movie, or a show with one season, has no season picker', async () => {
  const d = db({
    1: { format: 'MOVIE', episodes: 1, links: [['SEQUEL', 2]] },
    2: { format: 'TV', episodes: 12, links: [['PREQUEL', 1]] },
    5: { format: 'TV', episodes: 12, links: [['SIDE_STORY', 6], ['SPIN_OFF', 7]] },
    6: { format: 'TV', episodes: 12 },
    7: { format: 'TV', episodes: 12 }
  });
  assert.deepEqual(await walkSeasons(d.get(1), d.fetchMedia), []);
  assert.deepEqual(await walkSeasons(d.get(5), d.fetchMedia), [], 'spin-offs and side stories are not seasons');
});

test('season labels follow the titles', () => {
  assert.deepEqual(seasonLabels([
    'Attack on Titan', 'Attack on Titan Season 2', 'Attack on Titan Season 3', 'Attack on Titan Season 3 Part 2',
    'Attack on Titan Final Season', 'Attack on Titan Final Season Part 2'
  ]), ['Season 1', 'Season 2', 'Season 3', 'Season 3 Part 2', 'Final Season', 'Final Season Part 2']);
  assert.deepEqual(seasonLabels([
    'Mushoku Tensei: Jobless Reincarnation', 'Mushoku Tensei: Jobless Reincarnation Cour 2',
    'Mushoku Tensei: Jobless Reincarnation Season 2'
  ]), ['Season 1', 'Season 1 Part 2', 'Season 2']);
  assert.deepEqual(seasonLabels([
    'BLEACH: Thousand-Year Blood War', 'BLEACH: Thousand-Year Blood War - The Separation', 'BLEACH: Thousand-Year Blood War - The Conflict'
  ]), ['Season 1', 'Season 2', 'Season 3']);
  assert.deepEqual(seasonLabels(['Solo Leveling', 'Solo Leveling Season 2 -Arise from the Shadow-']), ['Season 1', 'Season 2']);
});
