// GenreScreen.tsx - Browse one genre: a poster grid that keeps loading more
// as you scroll, with a Netflix-style "Categories" switcher in the header.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import type { AnimeItem } from '../core/aniCliCore';
import { getAnimeByGenre, type Genre } from '../services/catalogService';
import { PosterCard } from '../components/PosterCard';
import { GenrePicker } from '../components/GenrePicker';

interface GenreScreenProps {
  genre: Genre;
  onBack: () => void;
  onSelectGenre: (genre: Genre) => void;
  onSelectAnime: (anime: AnimeItem) => void;
}

export const GenreScreen: React.FC<GenreScreenProps> = ({ genre, onBack, onSelectGenre, onSelectAnime }) => {
  const [items, setItems] = useState<AnimeItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const loadingRef = useRef(false);

  const loadNext = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    const next = page + 1;
    const result = await getAnimeByGenre(genre, next);
    setItems(prev => {
      const seen = new Set(prev.map(i => i.id));
      return [...prev, ...result.items.filter(i => !seen.has(i.id))];
    });
    setPage(next);
    setHasMore(result.hasMore && result.items.length > 0);
    setLoading(false);
    loadingRef.current = false;
  }, [genre, page, hasMore]);

  // First page on mount (App keys this screen by genre, so a genre switch
  // remounts with fresh state).
  useEffect(() => {
    loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadNext();
  };

  return (
    <div onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', paddingBottom: '90px' }}>
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        backgroundColor: 'var(--bg-main)',
        padding: 'calc(var(--safe-top) + 12px) 16px 12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px'
      }}>
        <button
          onClick={onBack}
          className="interactive glass-pill"
          aria-label="Back"
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            color: 'var(--text-primary)',
            flexShrink: 0
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ flex: 1, fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>{genre.name}</h1>
        <button
          onClick={() => setPickerOpen(true)}
          className="interactive glass-pill"
          style={{
            padding: '7px 12px',
            borderRadius: 'var(--radius-full)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            color: 'var(--text-primary)',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          <span>Categories</span>
          <ChevronDown size={16} />
        </button>
      </div>

      <div style={{
        padding: '4px 16px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
        gap: '14px 10px'
      }}>
        {items.map(anime => (
          <PosterCard key={anime.id} anime={anime} onClick={() => onSelectAnime(anime)} />
        ))}
        {page === 0 && loading && Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ borderRadius: '6px', paddingTop: '145%' }} />
        ))}
      </div>

      {loading && page > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '20px', color: 'var(--text-secondary)' }}>
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}
      {!loading && items.length === 0 && (
        <p style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)', fontSize: '14px' }}>
          Couldn't load {genre.name} titles right now. Check your connection and try again.
        </p>
      )}

      <GenrePicker
        open={pickerOpen}
        selectedSlug={genre.slug}
        onClose={() => setPickerOpen(false)}
        onSelect={(g) => {
          setPickerOpen(false);
          if (g.slug !== genre.slug) onSelectGenre(g);
        }}
      />
    </div>
  );
};
