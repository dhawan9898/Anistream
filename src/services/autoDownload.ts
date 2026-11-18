// autoDownload.ts - "Auto-download next episodes" and "Delete after watching".
//
// Driven by the native player's progress reports. Once an episode is half watched, the next
// few are downloaded (Wi-Fi only unless the viewer says otherwise), so a binge or a flight is
// ready; once an episode is (nearly) finished its download can be removed to free the space.
import type { AnimeItem, EpisodeItem } from '../providers/aniCliCore';
import { getUserPreferences } from './historyService';
import { downloadsSupported, findCompletedDownload, removeDownload, startDownload } from './downloadService';

const queued = new Set<string>();
const deleted = new Set<string>();

/** Wi-Fi or ethernet. Where the browser cannot tell, assume it is not, so mobile data is never spent by surprise. */
function onUnmeteredNetwork(): boolean {
  const type = (navigator as unknown as { connection?: { type?: string } }).connection?.type;
  return type === 'wifi' || type === 'ethernet';
}

export const AUTO_DOWNLOAD_AFTER = 0.5;
export const DELETE_WATCHED_AFTER = 0.92;

export async function handlePlaybackProgress(
  anime: AnimeItem, episode: EpisodeItem, mode: 'sub' | 'dub',
  episodes: EpisodeItem[], positionSec: number, durationSec: number
): Promise<void> {
  if (!downloadsSupported() || !(durationSec > 0)) return;
  const fraction = positionSec / durationSec;
  const key = `${anime.id}|${episode.id}|${mode}`;
  const prefs = await getUserPreferences();

  const count = Math.max(0, Math.min(5, prefs.autoDownloadNext ?? 0));
  if (count > 0 && fraction >= AUTO_DOWNLOAD_AFTER && !queued.has(key)) {
    if (prefs.autoDownloadWifiOnly === false || onUnmeteredNetwork()) {
      queued.add(key);
      const index = episodes.findIndex(e => e.id === episode.id);
      if (index >= 0) {
        for (const next of episodes.slice(index + 1, index + 1 + count)) {
          try { await startDownload(anime, next, mode); } catch { /* shown in Downloads; do not interrupt playback */ }
        }
      }
    }
  }

  if (prefs.deleteWatched && fraction >= DELETE_WATCHED_AFTER && !deleted.has(key)) {
    const record = findCompletedDownload(anime.id, episode.id, mode);
    if (record) {
      deleted.add(key);
      try { await removeDownload(record.id); } catch { /* try again on the next report */ deleted.delete(key); }
    }
  }
}
