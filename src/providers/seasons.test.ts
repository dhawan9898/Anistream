import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSeasons } from './catalogService.ts';
import type { AnimeItem } from './aniCliCore';

const item = (id: string, title: string, type = 'TV'): AnimeItem => ({ id, title, poster: '', path: '/' + id, type });

test('seasons of a franchise are ordered and labelled; movies and specials are left out', () => {
  const mha = item('mha-1', 'My Hero Academia');
  const out = pickSeasons(mha, [
    item('mha-3', 'My Hero Academia 3rd Season'),
    item('mha-m', 'My Hero Academia: Heroes Rising', 'Movie'),
    item('mha-2', 'My Hero Academia Season 2'),
    item('mha-s', 'My Hero Academia: Training of the Dead', 'OVA')
  ]);
  assert.deepEqual(out.map(x => [x.id, x.seasonLabel]), [['mha-1', 'Season 1'], ['mha-2', 'Season 2'], ['mha-3', 'Season 3']]);
});

test('a title with no other season has nothing to switch between', () => {
  assert.deepEqual(pickSeasons(item('op', 'One Piece'), [item('op-m', 'One Piece Film Red', 'Movie')]), []);
});

test('an unrelated title is never a season', () => {
  assert.deepEqual(pickSeasons(item('a', 'Naruto'), [item('b', 'Boruto: Naruto Next Generations')]), []);
});
