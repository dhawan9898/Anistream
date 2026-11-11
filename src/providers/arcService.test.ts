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
  const g = group([['First', 10], ['Second', 10]]);
  g.groups.reverse();
  assert.deepEqual(arcsFromGroup(g, 20).map(a => a.name), ['First', 'Second']);
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
