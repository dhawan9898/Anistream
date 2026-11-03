import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); } }
};
const { createThemeStore } = await import('./theme.ts');

const store = createThemeStore({ key: 't', syncKey: 'sync-t', themes: ['dark', 'light', 'slate'] as const, fallback: 'dark' });
beforeEach(() => ls.clear());

test('getSync reads the mirror and ignores unknown values', () => {
  assert.equal(store.getSync(), 'dark');
  ls.set('sync-t', 'slate');
  assert.equal(store.getSync(), 'slate');
  ls.set('sync-t', 'neon');
  assert.equal(store.getSync(), 'dark');
});
