// Tests for hedged server resolution (resolveFirstServer). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFirstServer, type StreamSource } from './aniCliCore.ts';

const src = (name: string): StreamSource => ({ streamUrl: name, quality: 'Auto', subtitles: [], referer: '' });
const after = <T>(ms: number, value: T) => new Promise<T>(r => setTimeout(() => r(value), ms));

test('a fast first server wins and no other server is started', async () => {
  const started: string[] = [];
  const result = await resolveFirstServer(['a', 'b', 'c'], '1', 'sub', hash => {
    started.push(hash);
    return after(10, src(hash));
  }, 100);
  assert.equal(result?.streamUrl, 'a');
  assert.deepEqual(started, ['a']);
});

test('a slow first server is hedged: the next one starts and can win', async () => {
  const started: string[] = [];
  const t0 = Date.now();
  const result = await resolveFirstServer(['slow', 'fast'], '1', 'sub', hash => {
    started.push(hash);
    return hash === 'slow' ? after(1000, src(hash)) : after(10, src(hash));
  }, 50);
  assert.equal(result?.streamUrl, 'fast');
  assert.deepEqual(started, ['slow', 'fast']);
  assert.ok(Date.now() - t0 < 500, 'did not wait for the slow server');
});

test('a failing server hands over to the next immediately', async () => {
  const t0 = Date.now();
  const result = await resolveFirstServer(['bad', 'empty', 'good'], '1', 'sub', hash => {
    if (hash === 'bad') return Promise.reject(new Error('403'));
    if (hash === 'empty') return Promise.resolve(null);
    return after(5, src(hash));
  }, 10_000);
  assert.equal(result?.streamUrl, 'good');
  assert.ok(Date.now() - t0 < 500, 'did not wait out the hedge delay');
});

test('resolves null when every server fails', async () => {
  const result = await resolveFirstServer(['a', 'b'], '1', 'sub', () => Promise.reject(new Error('down')), 10);
  assert.equal(result, null);
});

test('resolves null for an empty server list', async () => {
  assert.equal(await resolveFirstServer([], '1', 'sub', () => Promise.resolve(src('x'))), null);
});
