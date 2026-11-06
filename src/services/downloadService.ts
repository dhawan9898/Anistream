// downloadService.ts - Offline downloads of episodes (Android app only).
//
// The native DownloadsPlugin owns the video files (Media3 cache); this module
// keeps what the UI needs about each download - the title/episode, how to play
// it, its state - in IndexedDB, and mirrors the native progress events.
import { Capacitor } from '@capacitor/core';
import { DownloadsPlugin, type DownloadChangedEvent, type NativeDownloadState } from '../plugins/downloadsPlugin';
import { resolveStream } from '../providers/streamResolver';
import type { AnimeItem, EpisodeItem, StreamSource, SubtitleTrack, SkipRange } from '../providers/aniCliCore';
import { getUserPreferences } from './historyService';
import { cacheRead, cacheWrite, idbDelete, idbGetAll, idbPut } from './offlineStore';

export type DownloadState = 'queued' | 'downloading' | 'completed' | 'failed' | 'stopped';

export interface DownloadRecord {
  id: string;
  anime: AnimeItem;
  episode: EpisodeItem;
  mode: 'sub' | 'dub';
  state: DownloadState;
  percent: number;
  bytes: number;
  createdAt: number;
  // How to play it back offline.
  streamUrl: string;
  referer: string;
  subtitles: SubtitleTrack[];
  intro?: SkipRange;
  outro?: SkipRange;
  error?: string;
  // Retries of a failed download that reused its saved stream link.
  attempts?: number;
}

export const downloadsSupported = (): boolean => Capacitor.isNativePlatform();

export const downloadId = (animeId: string, episodeId: string, mode: 'sub' | 'dub'): string =>
  `${animeId}|${episodeId}|${mode}`;

// ------------------------------------------------------------------- store

let records = new Map<string, DownloadRecord>();
let snapshot: DownloadRecord[] = [];
const listeners = new Set<() => void>();
let ready: Promise<void> | null = null;

const publish = () => {
  snapshot = [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
  listeners.forEach(fn => fn());
};

export const subscribeDownloads = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const getDownloadsSnapshot = (): DownloadRecord[] => snapshot;

function toState(s: NativeDownloadState): DownloadState | null {
  return s === 'removing' || s === 'removed' ? null : s;
}

function apply(event: DownloadChangedEvent) {
  const rec = records.get(event.id);
  if (!rec) return;
  const state = toState(event.state);
  if (!state) return;
  const changedState = rec.state !== state;
  const next: DownloadRecord = { ...rec, state, percent: state === 'completed' ? 100 : event.percent, bytes: event.bytes };
  records.set(rec.id, next);
  if (changedState) void idbPut('downloads', next);
  publish();
}

/** Loads saved downloads and starts following the native side. Safe to call repeatedly. */
export function initDownloads(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const saved = await idbGetAll<DownloadRecord>('downloads');
    records = new Map(saved.map(r => [r.id, r]));
    publish();
    if (!downloadsSupported()) return;
    try {
      await DownloadsPlugin.addListener('downloadChanged', apply);
      const { downloads } = await DownloadsPlugin.list();
      const native = new Map(downloads.map(d => [d.id, d]));
      for (const rec of saved) {
        const n = native.get(rec.id);
        if (n) apply(n);
        // Unfinished with nothing behind it natively (e.g. app data cleared mid-way).
        else if (rec.state !== 'completed') {
          records.delete(rec.id);
          void idbDelete('downloads', rec.id);
        }
      }
      // Files without metadata can't be shown or played: free them.
      for (const n of downloads) if (!records.has(n.id)) void DownloadsPlugin.remove({ id: n.id });
      publish();
    } catch (err) {
      console.warn('[downloads] native side unavailable:', err);
    }
  })();
  return ready;
}

// ------------------------------------------------------------------ queries

export const findDownload = (animeId: string, episodeId: string, mode: 'sub' | 'dub'): DownloadRecord | undefined =>
  records.get(downloadId(animeId, episodeId, mode));

/** A finished download of this episode, in `mode` if possible, else in the other audio. */
export function findCompletedDownload(animeId: string, episodeId: string, mode: 'sub' | 'dub'): DownloadRecord | undefined {
  const exact = findDownload(animeId, episodeId, mode);
  if (exact?.state === 'completed') return exact;
  const other = findDownload(animeId, episodeId, mode === 'sub' ? 'dub' : 'sub');
  return other?.state === 'completed' ? other : undefined;
}

/** Finished downloads of one title, in `mode`, ordered by episode number. */
export function completedEpisodes(animeId: string, mode: 'sub' | 'dub'): EpisodeItem[] {
  return snapshot
    .filter(r => r.anime.id === animeId && r.mode === mode && r.state === 'completed')
    .map(r => r.episode)
    .sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
}

/** The stream description the player needs to play a download offline. */
export function sourceFromDownload(rec: DownloadRecord): StreamSource {
  return {
    streamUrl: rec.streamUrl,
    quality: 'Offline',
    subtitles: rec.subtitles,
    referer: rec.referer,
    masterUrl: rec.streamUrl,
    qualities: [],
    intro: rec.intro,
    outro: rec.outro
  };
}

// ------------------------------------------------------------------ actions

// Cover art is kept as a data URL so the Downloads list still shows it offline.
async function savePoster(anime: AnimeItem): Promise<void> {
  const key = `poster:${anime.id}`;
  if (!anime.poster || await cacheRead(key)) return;
  try {
    const blob = await (await fetch(anime.poster)).blob();
    if (blob.size > 600_000) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    await cacheWrite(key, dataUrl);
  } catch {
    // Best effort: the list falls back to the remote URL.
  }
}

export async function getOfflinePoster(animeId: string): Promise<string | null> {
  return (await cacheRead<string>(`poster:${animeId}`))?.value ?? null;
}

export async function startDownload(anime: AnimeItem, episode: EpisodeItem, mode: 'sub' | 'dub'): Promise<void> {
  if (!downloadsSupported()) throw new Error('Downloads are only available in the Android app.');
  await initDownloads();
  const id = downloadId(anime.id, episode.id, mode);
  const existing = records.get(id);
  if (existing && existing.state !== 'failed') return;

  // A failed download is retried on the SAME stream link first: the partly
  // downloaded data is cached under that link, so it carries on instead of
  // starting over. Only if that fails again (the link has probably expired)
  // is the partial data dropped and a fresh link resolved.
  const reuseLink = !!existing && existing.state === 'failed' && !!existing.streamUrl && (existing.attempts ?? 0) < 1;
  const placeholder: DownloadRecord = {
    id, anime, episode, mode, state: 'queued',
    percent: reuseLink ? existing.percent : 0, bytes: reuseLink ? existing.bytes : 0,
    createdAt: existing?.createdAt ?? Date.now(),
    streamUrl: reuseLink ? existing.streamUrl : '', referer: reuseLink ? existing.referer : '',
    subtitles: reuseLink ? existing.subtitles : [],
    intro: reuseLink ? existing.intro : undefined, outro: reuseLink ? existing.outro : undefined,
    attempts: reuseLink ? (existing.attempts ?? 0) + 1 : 0
  };
  records.set(id, placeholder);
  publish();

  try {
    let source: Pick<StreamSource, 'streamUrl' | 'referer' | 'subtitles' | 'intro' | 'outro'>;
    if (reuseLink) {
      source = { streamUrl: existing.streamUrl, referer: existing.referer, subtitles: [], intro: existing.intro, outro: existing.outro };
    } else {
      if (existing) await DownloadsPlugin.remove({ id }).catch(() => undefined);
      const resolved = await resolveStream(anime, episode, mode, { fresh: true });
      if (resolved.isFallback) throw new Error('This episode has no stream available right now.');
      source = resolved;
    }
    const prefs = await getUserPreferences();
    const { subtitles } = await DownloadsPlugin.start({
      id,
      url: source.streamUrl,
      referer: source.referer,
      maxHeight: Number(prefs.downloadQuality || '720'),
      subtitles: source.subtitles
    });
    const rec: DownloadRecord = {
      ...placeholder,
      streamUrl: source.streamUrl,
      referer: source.referer,
      // Captions already saved on an earlier attempt are kept.
      subtitles: subtitles?.length ? subtitles : placeholder.subtitles,
      intro: source.intro,
      outro: source.outro
    };
    // The native events may already have advanced the state.
    const current = records.get(id);
    const merged = current ? { ...rec, state: current.state, percent: current.percent, bytes: current.bytes } : rec;
    records.set(id, merged);
    await idbPut('downloads', merged);
    publish();
    void savePoster(anime);
  } catch (err) {
    const failed: DownloadRecord = { ...placeholder, state: 'failed', attempts: placeholder.attempts, error: err instanceof Error ? err.message : String(err) };
    records.set(id, failed);
    await idbPut('downloads', failed);
    publish();
    throw err;
  }
}

export async function removeDownload(id: string): Promise<void> {
  await initDownloads();
  records.delete(id);
  publish();
  await idbDelete('downloads', id);
  if (downloadsSupported()) await DownloadsPlugin.remove({ id }).catch(() => undefined);
  // The poster is only needed while some episode of the title is stored.
  const animeId = id.split('|')[0];
  if (![...records.values()].some(r => r.anime.id === animeId)) await idbDelete('cache', `poster:${animeId}`);
}

export async function removeAllDownloads(): Promise<void> {
  await initDownloads();
  for (const id of [...records.keys()]) await removeDownload(id);
}

export const totalDownloadedBytes = (): number =>
  snapshot.reduce((sum, r) => sum + (r.state === 'completed' ? r.bytes : 0), 0);

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
