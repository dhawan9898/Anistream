// previewService.ts - Which title's long-press preview is open. Any poster
// can open it (PosterCard), and one component rendered by App shows it.
import type { AnimeItem } from '../providers/aniCliCore';

let current: AnimeItem | null = null;
const listeners = new Set<() => void>();

export const getPreview = (): AnimeItem | null => current;

export const subscribePreview = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export function openPreview(anime: AnimeItem): void {
  current = anime;
  listeners.forEach(fn => fn());
}

export function closePreview(): void {
  if (!current) return;
  current = null;
  listeners.forEach(fn => fn());
}
