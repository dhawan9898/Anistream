import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSiteHost } from './siteConfig.ts';

test('only a plain https origin is accepted as the site address', () => {
  assert.equal(parseSiteHost('https://hianime.at'), 'https://hianime.at');
  assert.equal(parseSiteHost('https://hianime.at/'), 'https://hianime.at');
  for (const bad of ['http://hianime.at', 'https://user:pw@hianime.at', 'https://hianime.at/path', 'https://hianime.at/?q=1', 'javascript:alert(1)', 'hianime.at', '', 42, null, undefined]) {
    assert.equal(parseSiteHost(bad), null, String(bad));
  }
});
