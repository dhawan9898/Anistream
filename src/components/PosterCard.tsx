// PosterCard.tsx - Apple TV-style fluid poster tile with squircle geometry,
// liquid glass badges, and bouncy physics.
import React, { memo, useEffect, useRef } from 'react';
import type { AnimeItem } from '../providers/aniCliCore';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { hapticMedium } from '../services/hapticsService';
import { openPreview } from '../services/previewService';

interface PosterCardProps {
  anime: AnimeItem;
  // Receives the card's anime and optional bounding rect for shared element transition.
  onSelect?: (anime: AnimeItem, rect?: DOMRect) => void;
  // Fixed width for use inside a horizontal rail; omit to fill a grid cell.
  width?: number;
  // Small caption under the poster (e.g. "Season 2").
  caption?: string;
  highlighted?: boolean;
  badge?: string;
}

// Long press (finger held still) opens the title's details card.
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

const PosterCardBase: React.FC<PosterCardProps> = ({ anime, onSelect, width, caption, highlighted, badge }) => {
  const posterRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number>(0);
  const origin = useRef({ x: 0, y: 0 });
  // Set when a long press fired so the click that follows the release is ignored.
  const fired = useRef(false);
  const cancel = () => { window.clearTimeout(timer.current); timer.current = 0; };
  useEffect(() => cancel, []);

  const onClick = () => {
    if (fired.current) { fired.current = false; return; }
    hapticMedium();
    const rect = posterRef.current?.getBoundingClientRect();
    onSelect?.(anime, rect);
  };

  const displayBadge = badge || anime.type || null;

  return (
    <div
      onClick={onClick}
      onPointerDown={e => {
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        cancel();
        timer.current = window.setTimeout(() => {
          fired.current = true;
          hapticMedium();
          openPreview(anime);
        }, LONG_PRESS_MS);
      }}
      onPointerMove={e => {
        if (!timer.current) return;
        if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > MOVE_TOLERANCE_PX) cancel();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={e => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          openPreview(anime);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={caption && caption !== anime.title ? `${anime.title} - ${caption}` : anime.title}
      className="interactive card-bouncy poster-card"
      style={{
        flex: width ? `0 0 ${width}px` : undefined,
        width: width ? `${width}px` : '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
    >
      <div
        ref={posterRef}
        style={{
          position: 'relative',
          width: '100%',
          paddingTop: '142%',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          backgroundColor: 'rgba(127, 127, 127, 0.12)',
          boxShadow: highlighted ? '0 0 0 2.5px var(--accent-primary), var(--card-shadow)' : 'var(--card-shadow)',
          border: '1px solid var(--border-subtle)',
          transition: 'box-shadow 0.35s ease, border-color 0.35s ease'
        }}
      >
        {anime.poster && (
          <FadeImage
            src={anime.poster}
            alt={anime.title}
            loading="lazy"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover'
            }}
          />
        )}

        {/* Specular glass sheen highlight on top edge */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, transparent 24%, rgba(0,0,0,0.55) 100%)'
          }}
        />

        {displayBadge && (
          <span
            style={{
              position: 'absolute',
              top: '8px',
              left: '8px',
              backgroundColor: 'rgba(12, 12, 16, 0.65)',
              WebkitBackdropFilter: 'blur(14px)',
              backdropFilter: 'blur(14px)',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              color: '#ffffff',
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.2px',
              padding: '3px 7px',
              borderRadius: 'var(--radius-xs)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
              display: 'flex',
              alignItems: 'center',
              gap: '3px'
            }}
          >
            {displayBadge}
          </span>
        )}

        {/* Sub / Dub tag badge if available */}
        {(anime.dubCount || anime.subCount) && (
          <span
            style={{
              position: 'absolute',
              bottom: '8px',
              right: '8px',
              backgroundColor: 'rgba(12, 12, 16, 0.65)',
              WebkitBackdropFilter: 'blur(12px)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              color: '#ffffff',
              fontSize: '9px',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 'var(--radius-xs)'
            }}
          >
            {anime.dubCount ? 'SUB | DUB' : 'SUB'}
          </span>
        )}

        {!anime.poster && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12px',
              textAlign: 'center',
              fontSize: '13px',
              fontWeight: 700,
              color: 'var(--text-secondary)'
            }}
          >
            {anime.title}
          </span>
        )}
      </div>

      {(caption || !width) && (
        <div
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: highlighted ? 'var(--text-primary)' : 'var(--text-secondary)',
            lineHeight: 1.35,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            letterSpacing: '-0.2px'
          }}
        >
          {caption || anime.title}
        </div>
      )}
    </div>
  );
};

export const PosterCard = memo(PosterCardBase);
