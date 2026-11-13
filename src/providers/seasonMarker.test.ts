import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonMarker } from './catalogService.ts';

test('matching a season on the site never lands on another season', () => {
  // The prefix match "Solo Leveling" ~ "Solo Leveling Season 2 ..." must not count as the same entry.
  assert.notEqual(seasonMarker('Solo Leveling'), seasonMarker('Solo Leveling Season 2: Arise from the Shadow'));
  assert.equal(seasonMarker('Solo Leveling Season 2 -Arise from the Shadow-'), seasonMarker('Solo Leveling Season 2: Arise from the Shadow'));
  assert.equal(seasonMarker('My Hero Academia 2nd Season'), seasonMarker('My Hero Academia Season 2'));
  assert.equal(seasonMarker('One Punch Man'), seasonMarker('One Punch Man Season 1'));
  assert.notEqual(seasonMarker('Attack on Titan Season 3'), seasonMarker('Attack on Titan Season 3 Part 2'));
});
