// cloudAccount.ts - AniStream's account: what is synced between devices, and when.
import { createCloudSync } from './cloudSync.ts';
import { exportBackup, importBackup, subscribeLibraryChanges } from './historyService.ts';

const env = (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env) || {};

export const cloud = createCloudSync({
  app: 'anistream',
  url: env.VITE_SUPABASE_URL,
  anonKey: env.VITE_SUPABASE_ANON_KEY,
  collections: {
    // Continue Watching: one entry per title, the newest progress wins.
    history: { type: 'list', key: i => String(i.animeId), stamp: i => Number(i.updatedAt) },
    bookmarks: { type: 'list', key: i => String(i.id) },
    // Progress of every episode watched.
    episodeLog: { type: 'list', key: i => `${i.animeId}|${i.episodeId}`, stamp: i => Number(i.updatedAt) },
    // Sub or dub, remembered per title.
    titleModes: { type: 'map' },
    preferences: { type: 'blob' }
  },
  read: async () => {
    const b = JSON.parse(await exportBackup());
    return { history: b.history, bookmarks: b.bookmarks, episodeLog: b.episodeLog, titleModes: b.titleModes, preferences: b.preferences };
  },
  write: async state => { await importBackup(JSON.stringify({ app: 'AniStream', ...state })); }
});

let started = false;
/** Syncs at launch, when the app comes back to the front, and a few seconds after anything changes. */
export function startCloudSync(): void {
  if (started || !cloud.getStatus().configured) return;
  started = true;
  subscribeLibraryChanges(() => cloud.schedule());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void cloud.syncNow(); });
  void cloud.syncNow();
}
