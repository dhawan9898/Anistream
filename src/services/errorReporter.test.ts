import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { _resetErrorReporterForTests, configureErrorReporter, fingerprintOf, flush, reportError, scrubUrls } from './errorReporter.ts';

afterEach(() => _resetErrorReporterForTests());

function setup(opts: { ok?: boolean; online?: boolean } = {}) {
  const store = new Map<string, string>();
  const sent: Array<Record<string, unknown>[]> = [];
  const headers: Array<Record<string, string>> = [];
  let ok = opts.ok ?? true;
  configureErrorReporter({
    app: 'anistream', url: 'https://project.supabase.test', anonKey: 'k'.repeat(40), version: '2.0.1', device: 'android (Android 17; SM-S928U1)',
    accessToken: () => 'user-token',
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: k => { store.delete(k); } },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      if (!ok) throw new Error('offline');
      sent.push(JSON.parse(String(init?.body)));
      headers.push(init?.headers as Record<string, string>);
      return new Response('', { status: 201 });
    }) as typeof fetch
  });
  return { store, sent, headers, setOk: (v: boolean) => { ok = v; } };
}

test('URLs lose their query strings, secrets in context are removed', async () => {
  assert.equal(scrubUrls('GET https://api.themoviedb.org/3/tv/1?api_key=abc&x=1 failed'), 'GET https://api.themoviedb.org/3/tv/1 failed');
  const { sent } = setup();
  reportError('network', new Error('timed out: https://host/x?token=SECRET'), { url: 'https://host/y?key=SECRET', password: 'p', nested: { authorization: 'Bearer x', ok: 1 } });
  await flush();
  const body = JSON.stringify(sent);
  assert.ok(!body.includes('SECRET') && !body.includes('Bearer x') && !body.includes('"p"'), body);
  assert.equal(sent[0][0].message, 'timed out: https://host/x');
});

test('the same error is sent once per session, later sightings are counted', async () => {
  const { sent } = setup();
  for (let i = 0; i < 5; i++) reportError('provider', new Error(`vidrock failed for title ${100 + i}`), { i });
  reportError('provider', new Error('a different problem'));
  await flush();
  assert.equal(sent[0].length, 2);
  assert.equal(sent[0][0].occurrences, 5);
  assert.equal(sent[0][0].app, 'anistream');
  assert.equal(sent[0][0].kind, 'provider');
});

test('reports wait while offline and go out later; the user token is sent when signed in', async () => {
  const { sent, store, setOk, headers } = setup({ ok: false });
  reportError('crash', new Error('boom'));
  await flush();
  assert.equal(sent.length, 0);
  assert.ok(store.get('anistream_error_queue')?.includes('boom'), 'kept in storage for the next start');
  setOk(true);
  await flush();
  assert.equal(sent[0][0].message, 'boom');
  assert.equal(headers[0].Authorization, 'Bearer user-token');
  assert.equal(store.get('anistream_error_queue'), undefined, 'queue emptied once sent');
});

test('fingerprints group variants that differ only in numbers and URLs', () => {
  assert.equal(fingerprintOf('network', 'HTTP 404 from https://a.com/tv/1?x=1'), fingerprintOf('network', 'HTTP 404 from https://a.com/tv/2'));
  assert.notEqual(fingerprintOf('network', 'HTTP 404 from https://a.com/tv/1'), fingerprintOf('network', 'HTTP 404 from https://b.com/tv/1'));
});

test('nothing is sent before the reporter is configured, and a reporting failure never throws', async () => {
  assert.doesNotThrow(() => reportError('error', new Error('before setup')));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  setup();
  assert.doesNotThrow(() => reportError('error', circular as unknown as Error, circular));
});
