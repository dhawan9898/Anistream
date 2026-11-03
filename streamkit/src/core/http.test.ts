// Unit tests for the shared HTTP layer. Run with `npm test` (Node's built-in
// runner; no extra dependencies). fetch is replaced with a scripted fake.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request, getText, getJson, invalidateCache, HttpError } from './http.ts';

type Step = { status: number; body?: string; retryAfter?: string } | 'network-error' | 'hang';

let calls: string[] = [];
let script: Step[] = [];

function respond(step: Step): Promise<Response> {
  if (step === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
  if (step === 'hang') return new Promise(() => {});
  const headers = new Headers();
  // Retry-After: 0 keeps the backoff out of test time.
  headers.set('Retry-After', step.retryAfter ?? '0');
  return Promise.resolve(new Response(step.body ?? '', { status: step.status, headers }));
}

beforeEach(() => {
  calls = [];
  script = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    const step = script.shift() ?? { status: 200, body: 'default' };
    return respond(step);
  }) as typeof fetch;
});

test('retries a 503 and returns the eventual success', async () => {
  script = [{ status: 503 }, { status: 503 }, { status: 200, body: 'ok' }];
  const res = await request('https://x/a', undefined, { retries: 2 });
  assert.equal(await res.text(), 'ok');
  assert.equal(calls.length, 3);
});

test('does not retry a 404', async () => {
  script = [{ status: 404 }, { status: 200 }];
  await assert.rejects(request('https://x/b', undefined, { retries: 3 }), (err: unknown) =>
    err instanceof HttpError && err.status === 404);
  assert.equal(calls.length, 1);
});

test('gives up after the retry budget and reports the last failure', async () => {
  script = [{ status: 500 }, { status: 502 }];
  await assert.rejects(request('https://x/c', undefined, { retries: 1 }), (err: unknown) =>
    err instanceof HttpError && err.status === 502);
  assert.equal(calls.length, 2);
});

test('retries network errors', async () => {
  script = ['network-error', { status: 200, body: 'back' }];
  // Network errors use exponential backoff (~250-500ms for the first retry).
  const res = await request('https://x/d', undefined, { retries: 1 });
  assert.equal(await res.text(), 'back');
});

test('times out a hung request and retries it', async () => {
  script = ['hang', { status: 200, body: 'fast' }];
  const res = await request('https://x/e', undefined, { timeoutMs: 50, retries: 1 });
  assert.equal(await res.text(), 'fast');
  assert.equal(calls.length, 2);
});

test('concurrent GETs for the same URL share one request', async () => {
  script = [{ status: 200, body: 'shared' }];
  const [a, b] = await Promise.all([getText('https://x/f'), getText('https://x/f')]);
  assert.equal(a, 'shared');
  assert.equal(b, 'shared');
  assert.equal(calls.length, 1);
});

test('caches successful GETs for their TTL, and invalidateCache clears them', async () => {
  script = [{ status: 200, body: '{"v":1}' }, { status: 200, body: '{"v":2}' }];
  assert.deepEqual(await getJson('https://x/g', undefined, { ttlMs: 60000 }), { v: 1 });
  assert.deepEqual(await getJson('https://x/g', undefined, { ttlMs: 60000 }), { v: 1 });
  assert.equal(calls.length, 1);
  invalidateCache('x/g');
  assert.deepEqual(await getJson('https://x/g', undefined, { ttlMs: 60000 }), { v: 2 });
  assert.equal(calls.length, 2);
});

test('failed GETs are not cached', async () => {
  script = [{ status: 404 }, { status: 200, body: 'later' }];
  await assert.rejects(getText('https://x/h', undefined, { ttlMs: 60000 }));
  assert.equal(await getText('https://x/h', undefined, { ttlMs: 60000 }), 'later');
});

test('caps concurrent requests', async () => {
  let active = 0;
  let peak = 0;
  globalThis.fetch = (() => {
    active++;
    peak = Math.max(peak, active);
    return new Promise<Response>(resolve => setTimeout(() => {
      active--;
      resolve(new Response('x'));
    }, 20));
  }) as typeof fetch;
  await Promise.all(Array.from({ length: 20 }, (_, i) => request(`https://x/p${i}`)));
  assert.ok(peak <= 6, `peak concurrency was ${peak}`);
});
