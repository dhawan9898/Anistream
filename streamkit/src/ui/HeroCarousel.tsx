// HeroCarousel.tsx - Netflix-style featured banner: swipe between the top
// titles (native scroll-snap, so it tracks the finger 1:1), with page dots and
// an auto-advance that steps aside while the user is touching it or a screen
// covers it. Data-agnostic: each app maps its own items to HeroSlide.
import React, { useEffect, useRef, useState } from 'react';
import { Play, Plus, Check, Info } from 'lucide-react';
import { FadeImage } from './FadeImage.tsx';

const AUTO_ADVANCE_MS = 6000;
// After a manual swipe, wait this long before auto-advancing again.
const USER_IDLE_MS = 10000;
const HERO_HEIGHT = 440;

export interface HeroSlide {
  key: string;
  title: string;
  image: string;
  /** Small pills after the rank badge, e.g. ['TV', '12 eps']. */
  chips: string[];
  /** One line under the title, e.g. genres. */
  subline?: string;
  description?: string;
  saved: boolean;
}

export interface HeroCarouselProps {
  slides: HeroSlide[];
  rankLabel: string;
  primaryLabel: string;
  onPrimary: (key: string) => void;
  /** Adds an "Info" button next to the primary one. */
  onSecondary?: (key: string) => void;
  onToggleSaved: (key: string) => void;
  /** Show the words "My List" next to the +/check icon. */
  showListLabel?: boolean;
  /** True while another screen covers this one - no auto-advance then. */
  paused?: boolean;
}

export const HeroCarousel: React.FC<HeroCarouselProps> = ({
  slides, rankLabel, primaryLabel, onPrimary, onSecondary, onToggleSaved, showListLabel = false, paused = false
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastTouchRef = useRef<number>(0);
  const [index, setIndex] = useState<number>(0);

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

  if (slides.length === 0) {
    return <div className="skeleton" style={{ width: '100%', height: `${HERO_HEIGHT}px`, marginTop: '-60px', borderRadius: 0 }} />;
  }

  const chipStyle: React.CSSProperties = { fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '6px', color: '#cbd5e1' };

  return (
    <div style={{ position: 'relative', marginTop: '-60px' }}>
      <div
        ref={trackRef}
        className="hero-track"
        onTouchStart={markTouched}
        onPointerDown={markTouched}
        onWheel={markTouched}
      >
        {slides.map((slide, i) => (
          <div key={slide.key} className="hero-slide" style={{ height: `${HERO_HEIGHT}px` }}>
            <FadeImage
              src={slide.image}
              alt=""
              loading={i === 0 ? 'eager' : 'lazy'}
              fetchPriority={i === 0 ? 'high' : 'auto'}
              className="hero-img"
            />
            <div className="hero-overlay">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span className="hero-rank">#{i + 1} in {rankLabel}</span>
                {slide.chips.map(chip => (
                  <span key={chip} className="glass-pill-dark" style={chipStyle}>{chip}</span>
                ))}
              </div>
              <h1 className="hero-title">{slide.title}</h1>
              {slide.subline && (
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#e5e5e5', marginBottom: '6px', textShadow: '0 1px 6px rgba(0,0,0,0.8)' }}>
                  {slide.subline}
                </div>
              )}
              {slide.description && <p className="hero-desc">{slide.description}</p>}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button onClick={() => onPrimary(slide.key)} className="interactive hero-play">
                  <Play size={18} fill="#000" />
                  <span>{primaryLabel}</span>
                </button>
                {onSecondary && (
                  <button onClick={() => onSecondary(slide.key)} className="interactive glass-pill-dark hero-list" aria-label="More info">
                    <Info size={18} />
                    <span>Info</span>
                  </button>
                )}
                <button
                  onClick={() => onToggleSaved(slide.key)}
                  className="interactive glass-pill-dark hero-list"
                  aria-label={slide.saved ? 'Remove from My List' : 'Add to My List'}
                  aria-pressed={slide.saved}
                >
                  {slide.saved ? <Check size={18} /> : <Plus size={18} />}
                  {showListLabel && <span>My List</span>}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <div className="hero-dots" role="tablist" aria-label="Featured titles">
          {slides.map((slide, i) => (
            <button
              key={slide.key}
              role="tab"
              aria-selected={i === index}
              aria-label={`Show ${slide.title}`}
              onClick={() => { markTouched(); goTo(i); }}
              className={i === index ? 'hero-dot active' : 'hero-dot'}
            />
          ))}
        </div>
      )}
    </div>
  );
};
