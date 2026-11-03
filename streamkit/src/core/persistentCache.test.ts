import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentCache } from './persistentCache.ts';

function fakeStorage(quota = Infinity) {
  const m = new Map<string, string>();
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => {
      const used = [...m.entries()].filter(([kk]) => kk !== k).reduce((s, [, vv]) => s + vv.length, 0);
      if (used + v.length > quota) throw new Error('QuotaExceededError');
      m.set(k, v);
    }
  };
}

const make = (over: Partial<Parameters<typeof createPersistentCache>[0]> = {}) => {
  const storage = fakeStorage();
  let t = 1_000;
  const cache = createPersistentCache({ prefix: 'c_v2_', legacyPrefix: 'c_', maxChars: 3000, storage, now: () => t, ...over });
  return { cache, storage, advance: (ms: number) => { t += ms; } };
};

test('serves fresh entries, drops expired ones, but getEntry still exposes stale data', () => {
  const { cache, advance, storage } = make();
  cache.set('a', { n: 1 }, 100);
  assert.deepEqual(cache.get('a'), { n: 1 });
  advance(101);
  assert.equal(cache.getEntry<{ n: number }>('a')?.fresh, false);
  assert.deepEqual(cache.getEntry<{ n: number }>('a')?.data, { n: 1 });
  assert.equal(cache.get('a'), null);
  assert.equal(storage.m.has('c_v2_a'), false, 'expired entry removed from storage');
  assert.equal(cache.getEntry('a'), null);
});

test('survives a restart: a new cache instance reads what the old one wrote', () => {
  const { cache, storage } = make();
  cache.set('k', 'value', 10_000);
  const reborn = createPersistentCache({ prefix: 'c_v2_', maxChars: 3000, storage, now: () => 1_000 });
  assert.equal(reborn.get('k'), 'value');
});

test('stays within its character budget by evicting the oldest entries', () => {
  const { cache, storage, advance } = make({ maxChars: 1200 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) { cache.set(k, 'x'.repeat(250), 1e9); advance(10); }
  const total = [...storage.m.values()].reduce((s, v) => s + v.length, 0);
  assert.ok(total <= 1200, `used ${total}`);
  const reborn = createPersistentCache({ prefix: 'c_v2_', maxChars: 1200, storage, now: () => 5_000 });
  assert.equal(reborn.get('a'), null, 'oldest evicted from storage');
  assert.equal(reborn.get('e'), 'x'.repeat(250));
});

test('an entry bigger than a third of the budget is memory-only', () => {
  const { cache, storage } = make({ maxChars: 900 });
  cache.set('big', 'y'.repeat(500), 1e9);
  assert.equal(storage.m.size, 0);
  assert.equal(cache.get('big'), 'y'.repeat(500));
});

test('quota errors drop older entries and retry instead of throwing', () => {
  const storage = fakeStorage(700);
  let t = 1;
  const cache = createPersistentCache({ prefix: 'q_', maxChars: 100_000, storage, now: () => t });
  cache.set('a', 'a'.repeat(200), 1e9); t++;
  cache.set('b', 'b'.repeat(200), 1e9); t++;
  cache.set('c', 'c'.repeat(200), 1e9);
  assert.ok(storage.m.has('q_c'), 'newest write landed');
});

test('prune removes expired entries and older cache versions; clear removes everything', () => {
  const { cache, storage, advance } = make();
  storage.m.set('c_oldversion', '{"data":1,"savedAt":1,"ttlMs":1}');
  storage.m.set('unrelated', 'keep');
  cache.set('short', 1, 50); cache.set('long', 2, 1e9);
  advance(100);
  cache.prune();
  assert.equal(storage.m.has('c_oldversion'), false);
  assert.equal(storage.m.has('c_v2_short'), false);
  assert.equal(storage.m.has('c_v2_long'), true);
  cache.clear();
  assert.equal(storage.m.has('c_v2_long'), false);
  assert.equal(storage.m.get('unrelated'), 'keep');
});

test('methods work when detached from the cache object', () => {
  const { cache } = make();
  const { set, get, getAsync } = cache;
  set('d', 7, 1e9);
  assert.equal(get('d'), 7);
  return getAsync('d').then(v => assert.equal(v, 7));
});
