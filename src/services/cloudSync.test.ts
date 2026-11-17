import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudSync, mergeCollection, type CollectionSpec } from './cloudSync.ts';

const history: CollectionSpec = { type: 'list', key: i => String(i.id), stamp: i => Number(i.at) };
const list: CollectionSpec = { type: 'list', key: i => String(i.id) };

test('nothing in the cloud yet: local data is kept as it is', () => {
  assert.deepEqual(mergeCollection(history, undefined, [{ id: 1, at: 5 }], undefined), [{ id: 1, at: 5 }]);
});

test('first sync on a device: both sides are combined, newest progress first', () => {
  const merged = mergeCollection(history, undefined, [{ id: 1, at: 5 }, { id: 2, at: 9, pos: 'local' }], [{ id: 2, at: 4, pos: 'cloud' }, { id: 3, at: 7 }]);
  assert.deepEqual(merged, [{ id: 2, at: 9, pos: 'local' }, { id: 3, at: 7 }, { id: 1, at: 5 }]);
});

test('the same title watched on two devices keeps the newer progress', () => {
  const base = [{ id: 1, at: 1, pos: 10 }];
  assert.deepEqual(mergeCollection(history, base, [{ id: 1, at: 1, pos: 10 }], [{ id: 1, at: 8, pos: 90 }]), [{ id: 1, at: 8, pos: 90 }]);
  assert.deepEqual(mergeCollection(history, base, [{ id: 1, at: 9, pos: 95 }], [{ id: 1, at: 8, pos: 90 }]), [{ id: 1, at: 9, pos: 95 }]);
});

test('a title removed on one device is removed on the other, not brought back', () => {
  const base = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(mergeCollection(list, base, [{ id: 1 }], [{ id: 1 }, { id: 2 }]), [{ id: 1 }], 'removed here');
  assert.deepEqual(mergeCollection(list, base, [{ id: 1 }, { id: 2 }], [{ id: 1 }]), [{ id: 1 }], 'removed on the other device');
});

test('a removal does not win over progress made since the last sync', () => {
  const base = [{ id: 1, at: 1 }];
  assert.deepEqual(mergeCollection(history, base, [{ id: 1, at: 6 }], []), [{ id: 1, at: 6 }]);
});

test('maps merge per entry; settings are replaced as a whole', () => {
  const map: CollectionSpec = { type: 'map', stamp: v => Number((v as { at?: number }).at) };
  assert.deepEqual(mergeCollection(map, {}, { a: { at: 1 }, b: { at: 5 } }, { b: { at: 2 }, c: { at: 3 } }), { a: { at: 1 }, b: { at: 5 }, c: { at: 3 } });
  const blob: CollectionSpec = { type: 'blob' };
  assert.deepEqual(mergeCollection(blob, undefined, { theme: 'a' }, { theme: 'b' }), { theme: 'b' }, 'new device takes the cloud settings');
  assert.deepEqual(mergeCollection(blob, { theme: 'a' }, { theme: 'a' }, { theme: 'b' }), { theme: 'b' }, 'unchanged here: cloud wins');
  assert.deepEqual(mergeCollection(blob, { theme: 'a' }, { theme: 'c' }, { theme: 'b' }), { theme: 'c' }, 'changed here: this device wins');
});

// A tiny stand-in for the Supabase endpoints the client uses.
function fakeSupabase() {
  const rows = new Map<string, unknown>();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/auth/v1/token')) {
      const body = JSON.parse(String(init?.body));
      if (body.password && body.password !== 'right') return json({ error_description: 'Invalid login credentials' }, 400);
      return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'u1', email: 'a@b.c' } });
    }
    if (url.includes('/auth/v1/signup')) {
      const body = JSON.parse(String(init?.body));
      // Supabase: an already confirmed email gets an obfuscated user without identities and no email.
      if (body.email === 'taken@b.c') return json({ id: 'fake', email: body.email, identities: [] });
      return json({ id: 'new', email: body.email, identities: [{ provider: 'email' }], confirmation_sent_at: 'now' });
    }
    if (url.includes('/rest/v1/user_data') && (init?.method ?? 'GET') === 'GET') {
      return json([...rows.entries()].map(([kind, data]) => ({ kind, data })));
    }
    if (url.includes('/rest/v1/user_data')) {
      for (const row of JSON.parse(String(init?.body))) rows.set(row.kind, row.data);
      return new Response('', { status: 201 });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { rows, calls, fetchImpl };
}

function device(server: ReturnType<typeof fakeSupabase>, state: Record<string, unknown>) {
  const store = new Map<string, string>();
  const sync = createCloudSync({
    app: 'cinestream', url: 'https://project.supabase.test', anonKey: 'k'.repeat(40),
    collections: { history, bookmarks: list },
    read: async () => structuredClone(state),
    write: async next => { Object.assign(state, structuredClone(next)); },
    fetchImpl: server.fetchImpl,
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: k => { store.delete(k); } }
  });
  return { sync, state };
}

test('two devices signed in to one account end up with the same data', async () => {
  const server = fakeSupabase();
  const phone = device(server, { history: [{ id: 1, at: 5 }], bookmarks: [{ id: 'a' }] });
  const tablet = device(server, { history: [{ id: 2, at: 7 }], bookmarks: [] });
  await phone.sync.signIn('a@b.c', 'right');
  await tablet.sync.signIn('a@b.c', 'right');
  assert.deepEqual(tablet.state.history, [{ id: 2, at: 7 }, { id: 1, at: 5 }]);
  assert.deepEqual(tablet.state.bookmarks, [{ id: 'a' }]);
  await phone.sync.syncNow();
  assert.deepEqual(phone.state, tablet.state);

  // Removed on the phone, then synced on both: gone on the tablet too.
  phone.state.bookmarks = [];
  await phone.sync.syncNow();
  await tablet.sync.syncNow();
  assert.deepEqual(tablet.state.bookmarks, []);
  assert.equal(phone.sync.getStatus().error, null);
});

test('a wrong password is reported and nothing is synced; an unconfigured build does nothing', async () => {
  const server = fakeSupabase();
  const phone = device(server, { history: [], bookmarks: [] });
  await assert.rejects(phone.sync.signIn('a@b.c', 'wrong'), /Invalid login credentials/);
  assert.equal(phone.sync.getStatus().user, null);
  assert.ok(!server.calls.some(c => c.includes('user_data')));

  const off = createCloudSync({ app: 'cinestream', collections: {}, read: async () => ({}), write: async () => {} });
  assert.equal(off.getStatus().configured, false);
  await off.syncNow();
});

test('create account for an email that already has an account says so instead of waiting for a code', async () => {
  const server = fakeSupabase();
  const phone = device(server, { history: [], bookmarks: [] });
  await assert.rejects(phone.sync.signUp('taken@b.c', 'secret1'), /already has an account/);
  assert.deepEqual(await phone.sync.signUp('new@b.c', 'secret1'), { needsConfirmation: true });
  assert.equal(phone.sync.getStatus().user, null);
});
