// streamResolver.ts - Resolves episode streams, sharing the work between the
// "next episode" prefetch and an explicit play request.
//
// Resolving a stream is several sequential requests (servers, embed, token
// decryption) and takes seconds. The next episode is resolved ahead of time
// while the current one plays; if the viewer presses Next before that has
// finished, the request must join the one already in flight instead of
// starting over - restarting doubled the wait and was a big part of the
// "stuck on loading" reports.
import { getEpisodeStream, type AnimeItem, type EpisodeItem, type StreamSource } from '../core/aniCliCore';

// Stream links are time-limited; a resolved one is only reused briefly.
const REUSE_MS = 4 * 60 * 1000;

interface Entry {
  promise: Promise<StreamSource>;
  createdAt: number;
}

const entries = new Map<string, Entry>();

const keyOf = (anime: AnimeItem, episode: EpisodeItem, mode: 'sub' | 'dub') =>
  `${anime.id}|${episode.id}|${mode}`;

export interface ResolveOptions {
  // Skip anything cached/in flight (a retry, or a stream that just failed).
  fresh?: boolean;
}

export function resolveStream(
  anime: AnimeItem,
  episode: EpisodeItem,
  mode: 'sub' | 'dub',
  options: ResolveOptions = {}
): Promise<StreamSource> {
  const key = keyOf(anime, episode, mode);
  const existing = entries.get(key);
  if (!options.fresh && existing && Date.now() - existing.createdAt < REUSE_MS) {
    // Callers adjust the source they get (preferred quality), so each gets a copy.
    return existing.promise.then(source => ({ ...source }));
  }

  const promise = getEpisodeStream(anime.id || anime.title, episode.id || episode.number, mode, anime.id);
  const entry: Entry = { promise, createdAt: Date.now() };
  entries.set(key, entry);
  promise
    .then(source => {
      // The demo fallback is never worth reusing.
      if (source.isFallback && entries.get(key) === entry) entries.delete(key);
    })
    .catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
  // Bound the map; oldest entries first.
  while (entries.size > 8) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return promise.then(source => ({ ...source }));
}

export function forgetStream(anime: AnimeItem, episode: EpisodeItem, mode: 'sub' | 'dub'): void {
  entries.delete(keyOf(anime, episode, mode));
}
