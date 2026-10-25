// HeroCarousel.tsx - Netflix-style featured banner: swipe between the top
// trending titles (native scroll-snap, so it tracks the finger 1:1), with
// page dots and an auto-advance that steps aside while the user is touching
// it or a player covers the screen.
import React, { useEffect, useRef, useState } from 'react';
import { Play, Plus, Check } from 'lucide-react';
import type { AnimeItem } from '../core/aniCliCore';
import { FadeImage } from './FadeImage';
import { getBookmarks, subscribeLibraryChanges, toggleBookmark } from '../services/historyService';

const MAX_SLIDES = 8;
const AUTO_ADVANCE_MS = 6000;
// After a manual swipe, wait this long before auto-advancing again.
const USER_IDLE_MS = 10000;
const HERO_HEIGHT = 440;

interface HeroCarouselProps {
  items: AnimeItem[];
  onSelect: (anime: AnimeItem) => void;
  // True while a player covers the screen - no auto-advance then.
  paused?: boolean;
}

export const HeroCarousel: React.FC<HeroCarouselProps> = ({ items, onSelect, paused = false }) => {
  const slides = items.slice(0, MAX_SLIDES);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastTouchRef = useRef<number>(0);
  const [index, setIndex] = useState<number>(0);
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

  // Current slide follows the scroll position (rAF-throttled).
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const width = track.clientWidth || 1;
        setIndex(Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / width))));
      });
    };
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [slides.length]);

  const goTo = (i: number) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
  };

  // Auto-advance; skipped while hidden, covered, or recently touched.
  useEffect(() => {
    if (slides.length < 2 || paused) return;
    const timer = window.setInterval(() => {
      if (document.hidden || Date.now() - lastTouchRef.current < USER_IDLE_MS) return;
      const track = trackRef.current;
      if (!track) return;
      const current = Math.round(track.scrollLeft / (track.clientWidth || 1));
      goTo((current + 1) % slides.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [slides.length, paused]);

  const markTouched = () => { lastTouchRef.current = Date.now(); };

  const handleToggleList = async (anime: AnimeItem) => {
    const nowSaved = await toggleBookmark(anime);
    setSaved(prev => {
      const next = new Set(prev);
      if (nowSaved) next.add(anime.id); else next.delete(anime.id);
      return next;
    });
  };

  if (slides.length === 0) {
    return <div className="skeleton" style={{ width: '100%', height: `${HERO_HEIGHT}px`, marginTop: '-60px' }} />;
  }

  return (
    <div style={{ position: 'relative', marginTop: '-60px' }}>
      <div
        ref={trackRef}
        className="hero-track"
        onTouchStart={markTouched}
        onPointerDown={markTouched}
        onWheel={markTouched}
      >
        {slides.map((anime, i) => {
          const inList = saved.has(anime.id);
          return (
            <div key={anime.id} className="hero-slide" style={{ height: `${HERO_HEIGHT}px` }}>
              <FadeImage
                src={anime.banner || anime.poster}
                alt=""
                loading={i === 0 ? 'eager' : 'lazy'}
                className="hero-img"
              />
              <div className="hero-overlay">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span className="hero-rank">#{i + 1} in Trending</span>
                  <span className="glass-pill-dark" style={{ fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '4px', color: '#cbd5e1' }}>
                    {anime.type || 'TV'}
                  </span>
                  {!!anime.subCount && (
                    <span className="glass-pill-dark" style={{ fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '4px', color: '#cbd5e1' }}>
                      {anime.subCount} eps
                    </span>
                  )}
                </div>
                <h1 className="hero-title">{anime.title}</h1>
                {anime.description && <p className="hero-desc">{anime.description}</p>}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button onClick={() => onSelect(anime)} className="interactive hero-play">
                    <Play size={18} fill="#000" />
                    <span>Watch Now</span>
                  </button>
                  <button
                    onClick={() => handleToggleList(anime)}
                    className="interactive glass-pill-dark hero-list"
                    aria-label={inList ? 'Remove from My List' : 'Add to My List'}
                    aria-pressed={inList}
                  >
                    {inList ? <Check size={18} /> : <Plus size={18} />}
                    <span>My List</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {slides.length > 1 && (
        <div className="hero-dots" role="tablist" aria-label="Featured titles">
          {slides.map((anime, i) => (
            <button
              key={anime.id}
              role="tab"
              aria-selected={i === index}
              aria-label={`Show ${anime.title}`}
              onClick={() => { markTouched(); goTo(i); }}
              className={i === index ? 'hero-dot active' : 'hero-dot'}
            />
          ))}
        </div>
      )}
    </div>
  );
};
