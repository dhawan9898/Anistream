// GenrePicker.tsx - Netflix "Categories" overlay: a dimmed full-screen list
// of genre names, centered, with a round close button pinned at the bottom.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { getGenres, type Genre } from '../services/catalogService';
import { useBackHandler } from '../services/backStack';

interface GenrePickerProps {
  open: boolean;
  selectedSlug?: string;
  onSelect: (genre: Genre) => void;
  onClose: () => void;
}

export const GenrePicker: React.FC<GenrePickerProps> = ({ open, selectedSlug, onSelect, onClose }) => {
  const [genres, setGenres] = useState<Genre[]>([]);

  useEffect(() => {
    if (open && genres.length === 0) getGenres().then(setGenres);
  }, [open, genres.length]);

  useBackHandler(open, onClose);

  if (!open) return null;

  // Portaled to <body>: the screens are wrapped in an animated container
  // (its own stacking context), which would otherwise keep this overlay
  // underneath the bottom dock.
  return createPortal(
    <div
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9500,
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 'calc(var(--safe-top) + 40px) 20px 120px 20px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '22px'
      }}>
        {genres.map(genre => {
          const active = genre.slug === selectedSlug;
          return (
            <button
              key={genre.slug}
              onClick={() => onSelect(genre)}
              style={{
                background: 'none',
                border: 'none',
                color: active ? '#fff' : '#b3b3b3',
                fontSize: active ? '22px' : '18px',
                fontWeight: active ? 800 : 500,
                cursor: 'pointer'
              }}
            >
              {genre.name}
            </button>
          );
        })}
      </div>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        padding: '24px 0 calc(var(--safe-bottom) + 28px) 0',
        display: 'flex',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.95) 45%)'
      }}>
        <button
          onClick={onClose}
          aria-label="Close categories"
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            border: 'none',
            backgroundColor: '#fff',
            color: '#000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer'
          }}
        >
          <X size={26} />
        </button>
      </div>
    </div>,
    document.body
  );
};
