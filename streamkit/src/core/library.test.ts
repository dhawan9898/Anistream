import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue, createChangeNotifier, parseValidatedList } from './library.ts';

test('serial queue runs tasks in order and survives a failing task', async () => {
  const run = createSerialQueue();
  const order: string[] = [];
  const a = run(async () => { await new Promise(r => setTimeout(r, 20)); order.push('a'); return 1; });
  const b = run(async () => { order.push('b'); throw new Error('boom'); });
  const c = run(async () => { order.push('c'); return 3; });
  assert.equal(await a, 1);
  await assert.rejects(b, /boom/);
  assert.equal(await c, 3);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('notifier delivers, isolates listener errors, and unsubscribes', () => {
  const errors: unknown[] = [];
  const n = createChangeNotifier(e => errors.push(e));
  let calls = 0;
  n.subscribe(() => { throw new Error('bad listener'); });
  const off = n.subscribe(() => { calls++; });
  n.notify();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  off();
  n.notify();
  assert.equal(calls, 1);
});

test('notifier holds soft notifications during playback and flushes once afterwards', () => {
  const n = createChangeNotifier();
  let calls = 0;
  n.subscribe(() => { calls++; });
  n.setPlaybackActive(true);
  n.notify(false); n.notify(false); n.notify(false);
  assert.equal(calls, 0);
  n.notify(true);
  assert.equal(calls, 1, 'forced notifications still go through');
  n.setPlaybackActive(false);
  assert.equal(calls, 2, 'held ones are delivered once');
  n.setPlaybackActive(false);
  assert.equal(calls, 2);
});

test('parseValidatedList drops bad entries and survives corrupt JSON', () => {
  const ok = (x: unknown) => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string';
  assert.deepEqual(parseValidatedList('[{"id":"a"},{"id":5},null,"x"]', ok), [{ id: 'a' }]);
  assert.deepEqual(parseValidatedList('{"id":"a"}', ok), []);
  assert.deepEqual(parseValidatedList('{broken', ok), []);
  assert.deepEqual(parseValidatedList(null, ok), []);
});
