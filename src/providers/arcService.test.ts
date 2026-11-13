import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcsFromGroup } from './arcService.ts';

const group = (sizes: [string, number][]) => ({
  groups: sizes.map(([name, n], order) => ({ name, order, episodes: Array.from({ length: n }, (_, i) => ({ order: i })) }))
});

test('story arcs become consecutive episode ranges', () => {
  const arcs = arcsFromGroup(group([['East Blue', 61], ['Alabasta', 74], ['Sky Island', 71]]), 206);
  assert.deepEqual(arcs, [
    { name: 'East Blue', start: 1, end: 61 },
    { name: 'Alabasta', start: 62, end: 135 },
    { name: 'Sky Island', start: 136, end: 206 }
  ]);
});

test('arcs come in the group order, not the order TMDB lists them', () => {
  const g = group([['First', 30], ['Second', 30]]);
  g.groups.reverse();
  assert.deepEqual(arcsFromGroup(g, 60).map(a => a.name), ['First', 'Second']);
});

test('an ongoing show: episodes past the last arc get their own range', () => {
  const arcs = arcsFromGroup(group([['A', 50], ['B', 50]]), 110);
  assert.deepEqual(arcs.at(-1), { name: 'Latest episodes', start: 101, end: 110 });
});

test('arcs are cut to the episodes the site has', () => {
  const arcs = arcsFromGroup(group([['A', 50], ['B', 50], ['C', 20]]), 110);
  assert.deepEqual(arcs.at(-1), { name: 'C', start: 101, end: 110 });
});

test('no arcs when they would not help or do not fit the site', () => {
  assert.deepEqual(arcsFromGroup(group([['Only arc', 24]]), 24), [], 'a single arc is no picker');
  assert.deepEqual(arcsFromGroup(group([['A', 12], ['B', 12]]), 1000), [], 'a different season split');
  assert.deepEqual(arcsFromGroup({}, 50), []);
});

test('a single short season is never split into arcs', () => {
  assert.deepEqual(arcsFromGroup(group([['A', 6], ['B', 6]]), 12), []);
});

import { rankArcGroups } from './arcService.ts';

test('the official arc list wins, whatever type TMDB files it under (Naruto Shippuden)', () => {
  // Real episode_groups of TMDB show 31910, trimmed.
  const groups = [
    { id: 'a', type: 1, group_count: 23, episode_count: 505, name: 'Released Order Episodes' },
    { id: 'b', type: 2, group_count: 29, episode_count: 500, name: 'Italian Sagas' },
    { id: 'c', type: 2, group_count: 29, episode_count: 500, name: 'Official Story Arcs' },
    { id: 'd', type: 2, group_count: 32, episode_count: 504, name: 'Chronological, organized by arc.' },
    { id: 'e', type: 5, group_count: 14, episode_count: 304, name: 'Story Arcs' }
  ];
  assert.equal(rankArcGroups(groups, 500)[0].id, 'c');
  assert.ok(!rankArcGroups(groups, 500).some(g => g.id === 'e'), '304 episodes do not fit 500');
});

test('an English arc list beats one made for another country (Hunter x Hunter)', () => {
  const groups = [
    { id: 'fr', type: 5, group_count: 7, episode_count: 148, name: 'French Arcs' },
    { id: 'en', type: 5, group_count: 6, episode_count: 148, name: 'Story Arcs' },
    { id: 'cn', type: 5, group_count: 8, episode_count: 148, name: 'Chinese Arcs' },
    { id: 'pr', type: 6, group_count: 3, episode_count: 148, name: 'Production' }
  ];
  assert.deepEqual(rankArcGroups(groups, 148).map(g => g.id), ['en', 'fr', 'cn']);
});

test('season splits filed as story arcs are not arcs', () => {
  const groups = [{ id: 's', type: 5, group_count: 4, episode_count: 220, name: 'Seasons' }];
  assert.deepEqual(rankArcGroups(groups, 220), []);
});

const ep = (season: number, n: number) => ({ order: n, season_number: season, episode_number: n });
const span = (season: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ep(season, from + i));

test('One Piece: specials are skipped and arcs keep their real episode numbers across filler', () => {
  const details = {
    groups: [
      { name: 'TV Specials', order: 0, episodes: [ep(0, 11), ep(0, 12), ep(0, 33)] },
      { name: 'East Blue', order: 1, episodes: span(1, 1, 61) },
      // 62-130; then 131-143 is filler that is in no official arc.
      { name: 'Alabasta', order: 2, episodes: span(2, 62, 130) },
      { name: 'Skypiea', order: 3, episodes: span(3, 144, 195) }
    ]
  };
  assert.deepEqual(arcsFromGroup(details, 200), [
    { name: 'East Blue', start: 1, end: 61 },
    { name: 'Alabasta', start: 62, end: 143 },
    { name: 'Skypiea', start: 144, end: 195 },
    { name: 'Latest episodes', start: 196, end: 200 }
  ]);
});
