import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeWatchState, isEpisodeFinished } from './historyService.ts';

test('an episode with under 30s left, or 95% watched, counts as finished', () => {
  assert.equal(isEpisodeFinished({ currentTime: 1400, duration: 1420 }), true);
  assert.equal(isEpisodeFinished({ currentTime: 1350, duration: 1420 }), true);
  assert.equal(isEpisodeFinished({ currentTime: 600, duration: 1420 }), false);
  assert.equal(isEpisodeFinished({ currentTime: 10, duration: 0 }), false);
});

test('episodeWatchState distinguishes unwatched, partial and finished', () => {
  assert.equal(episodeWatchState(undefined), 'unwatched');
  assert.equal(episodeWatchState({ currentTime: 5, duration: 1400 }), 'unwatched');
  assert.equal(episodeWatchState({ currentTime: 700, duration: 1400 }), 'partial');
  assert.equal(episodeWatchState({ currentTime: 1395, duration: 1400 }), 'finished');
});
