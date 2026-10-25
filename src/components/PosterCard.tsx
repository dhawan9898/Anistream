// PosterCard.tsx - Compact poster tile used by the horizontal rails
// (genre rows, Collection) and poster grids (genre pages, More Like This).
import React from 'react';
import type { AnimeItem } from '../core/aniCliCore';
import { FadeImage } from './FadeImage';

interface PosterCardProps {
  anime: AnimeItem;
  onClick: () => void;
  // Fixed width for use inside a horizontal rail; omit to fill a grid cell.
  width?: number;
  // Small caption under the poster (e.g. "Season 2").
  caption?: string;
  highlighted?: boolean;
  badge?: string;
}

export const PosterCard: React.FC<PosterCardProps> = ({ anime, onClick, width, caption, highlighted, badge }) => (
  <div
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    }}
    role="button"
    tabIndex={0}
    aria-label={caption && caption !== anime.title ? `${anime.title} - ${caption}` : anime.title}
    className="interactive"
    style={{
      flex: width ? `0 0 ${width}px` : undefined,
      width: width ? `${width}px` : '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      cursor: 'pointer'
    }}
  >
    <div style={{
      position: 'relative',
      width: '100%',
      paddingTop: '145%',
      borderRadius: '4px',
      overflow: 'hidden',
      backgroundColor: 'rgba(127, 127, 127, 0.15)',
      boxShadow: highlighted ? '0 0 0 2px #fff' : 'none'
    }}>
      {anime.poster && (
        <FadeImage
          src={anime.poster}
          alt={anime.title}
          loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      {badge && (
        <span style={{
          position: 'absolute',
          top: '6px',
          left: '6px',
          backgroundColor: 'rgba(0,0,0,0.75)',
          color: '#fff',
          fontSize: '10px',
          fontWeight: 700,
          padding: '2px 6px',
          borderRadius: '3px'
        }}>
          {badge}
        </span>
      )}
      {!anime.poster && (
        <span style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px',
          textAlign: 'center',
          fontSize: '12px',
          fontWeight: 700,
          color: 'var(--text-secondary)'
        }}>
          {anime.title}
        </span>
      )}
    </div>
    {(caption || !width) && (
      <div style={{
        fontSize: '12px',
        fontWeight: 600,
        color: highlighted ? 'var(--text-primary)' : 'var(--text-secondary)',
        lineHeight: 1.3,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden'
      }}>
        {caption || anime.title}
      </div>
    )}
  </div>
);
