import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver } from './updateService.ts';

test('compareSemver handles AniStream versioning', () => {
  assert.equal(compareSemver('v10.16', '10.15.0'), 1);
  assert.equal(compareSemver('10.15.0', '10.15.0'), 0);
  assert.equal(compareSemver('10.14.0', '10.15.0'), -1);
  assert.equal(compareSemver('v11.0.0', '10.15.0'), 1);
});
