import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHedged } from './hedged.ts';
import { ProviderHealth, LastGoodStore, type KeyValueStore } from './health.ts';

const after = <T,>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms));
const memStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};

test('hedged: a fast first candidate wins and nothing else starts', async () => {
  const started: string[] = [];
  const r = await resolveHedged(['a', 'b'], x => { started.push(x); return after(5, x); }, { hedgeDelayMs: 100 });
  assert.equal(r, 'a');
  assert.deepEqual(started, ['a']);
});

test('hedged: a slow first candidate is hedged by the next', async () => {
  const t0 = Date.now();
  const r = await resolveHedged(['slow', 'fast'], x => after(x === 'slow' ? 1000 : 5, x), { hedgeDelayMs: 30 });
  assert.equal(r, 'fast');
  assert.ok(Date.now() - t0 < 500);
});

test('hedged: failures (reject, null, sync throw) hand over immediately; all failing yields null', async () => {
  const errors: number[] = [];
  const t0 = Date.now();
  const r = await resolveHedged(['x', 'y', 'z', 'ok'], (item): Promise<string | null> => {
    if (item === 'x') return Promise.reject(new Error('403'));
    if (item === 'y') return Promise.resolve(null);
    if (item === 'z') throw new Error('sync');
    return after(5, item);
  }, { hedgeDelayMs: 10_000, onError: (_e, i) => errors.push(i) });
  assert.equal(r, 'ok');
  assert.deepEqual(errors, [0, 2]);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(await resolveHedged([], async () => 'never', { hedgeDelayMs: 1 }), null);
  assert.equal(await resolveHedged(['a'], async () => null, { hedgeDelayMs: 1 }), null);
});

test('health: three failures bench a provider until the cooldown passes; success clears it', () => {
  let now = 1000;
  const store = memStore();
  const h = new ProviderHealth({ storageKey: 'h', store, now: () => now, cooldownMs: 500 });
  h.record('p', false); h.record('p', false);
  assert.equal(h.isCoolingDown('p'), false);
  h.record('p', false);
  assert.equal(h.isCoolingDown('p'), true);
  now += 501;
  assert.equal(h.isCoolingDown('p'), false);
  h.record('p', false); h.record('p', false); h.record('p', false);
  h.record('p', true);
  assert.equal(h.isCoolingDown('p'), false);
  assert.equal(new ProviderHealth({ storageKey: 'h', store, now: () => now }).isCoolingDown('p'), false, 'persisted state reloads');
});

test('lastGood: remembers per key, caps its size, survives reload', () => {
  const store = memStore();
  const l = new LastGoodStore('lg', 2, store);
  l.remember('a', 'p1'); l.remember('b', 'p2'); l.remember('c', 'p3');
  assert.equal(l.get('a'), undefined, 'oldest evicted');
  assert.equal(l.get('c'), 'p3');
  assert.equal(new LastGoodStore('lg', 2, store).get('b'), 'p2');
  l.remember('b', undefined);
  assert.equal(l.get('b'), 'p2', 'undefined provider is ignored');
});
