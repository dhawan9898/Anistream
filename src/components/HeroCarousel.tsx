// HeroCarousel.tsx - AniStream's featured banner: maps anime to the shared
// carousel and keeps the "My List" state in sync with the library.
import React, { useEffect, useMemo, useState } from 'react';
import { HeroCarousel as SharedHeroCarousel, type HeroSlide } from 'streamkit/ui/HeroCarousel.tsx';
import type { AnimeItem } from '../core/aniCliCore';
import { getBookmarks, subscribeLibraryChanges, toggleBookmark } from '../services/historyService';

const MAX_SLIDES = 8;

interface HeroCarouselProps {
  items: AnimeItem[];
  onSelect: (anime: AnimeItem) => void;
  // True while a player covers the screen - no auto-advance then.
  paused?: boolean;
}

export const HeroCarousel: React.FC<HeroCarouselProps> = ({ items, onSelect, paused = false }) => {
  const anime = useMemo(() => items.slice(0, MAX_SLIDES), [items]);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  // My List state for the "+" button.
  useEffect(() => {
    let cancelled = false;
    const load = () => getBookmarks().then(list => {
      if (!cancelled) setSaved(new Set(list.map(b => b.id)));
    });
    load();
    const unsubscribe = subscribeLibraryChanges(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const slides: HeroSlide[] = useMemo(() => anime.map(a => ({
    key: a.id,
    title: a.title,
    image: a.banner || a.poster,
    chips: [a.type || 'TV', ...(a.subCount ? [`${a.subCount} eps`] : [])],
    description: a.description,
    saved: saved.has(a.id)
  })), [anime, saved]);

  const find = (key: string) => anime.find(a => a.id === key);

  const handleToggle = async (key: string) => {
    const target = find(key);
    if (!target) return;
    const nowSaved = await toggleBookmark(target);
    setSaved(prev => {
      const next = new Set(prev);
      if (nowSaved) next.add(key); else next.delete(key);
      return next;
    });
  };

  return (
    <SharedHeroCarousel
      slides={slides}
      rankLabel="Trending"
      primaryLabel="Watch Now"
      onPrimary={key => { const a = find(key); if (a) onSelect(a); }}
      onToggleSaved={handleToggle}
      showListLabel
      paused={paused}
    />
  );
};
