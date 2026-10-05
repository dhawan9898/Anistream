// SearchScreen.tsx - Rapid anime search powered by ani-cli scraper
import React, { useState, useEffect, useRef } from 'react';
import { Search as SearchIcon, X, Loader2, ArrowLeft } from 'lucide-react';
import { searchAnime, type AnimeItem } from '../core/aniCliCore';
import { ErrorState } from '../components/ErrorState';
import { getGenres, type Genre } from '../services/catalogService';

// Tile colors for the "Browse by genre" grid, cycled in order.
const GENRE_TILE_COLORS = ['#b91c1c', '#7c3aed', '#0e7490', '#b45309', '#be185d', '#15803d', '#1d4ed8', '#9f1239'];

interface SearchScreenProps {
  onBack: () => void;
  onSelectAnime: (anime: AnimeItem) => void;
  onSelectGenre: (genre: Genre) => void;
}

const POPULAR_TAGS = [
  "Solo Leveling",
  "One Piece",
  "Jujutsu Kaisen",
  "Demon Slayer",
  "Bleach",
  "Naruto",
  "Cyberpunk",
  "Frieren"
];

export const SearchScreen: React.FC<SearchScreenProps> = ({
  onBack,
  onSelectAnime,
  onSelectGenre
}) => {
  const [genres, setGenres] = useState<Genre[]>([]);

  useEffect(() => {
    getGenres().then(setGenres);
  }, []);

  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<AnimeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchFailed, setSearchFailed] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Typing is debounced and only the newest request may update the screen,
  // so a slow response for an earlier keystroke can't overwrite newer results.
  const searchSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    searchSeq.current++;
  }, []);

  const runSearch = async (searchTerm: string) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    setSearchFailed(false);
    try {
      const list = await searchAnime(searchTerm);
      if (seq === searchSeq.current) setResults(list);
    } catch (err) {
      console.warn('[SearchScreen] search failed:', err);
      if (seq === searchSeq.current) {
        setResults([]);
        setSearchFailed(true);
      }
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  };

  const handleSearch = (searchTerm: string, immediate = true) => {
    setQuery(searchTerm);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!searchTerm.trim()) {
      searchSeq.current++;
      setResults([]);
      setLoading(false);
      setSearchFailed(false);
      return;
    }
    if (immediate) {
      runSearch(searchTerm);
    } else {
      setLoading(true);
      debounceTimer.current = setTimeout(() => runSearch(searchTerm), 350);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '90px', display: 'flex', flexDirection: 'column' }}>
      {/* Sticky Header with Search Bar */}
      <div 
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          backgroundColor: 'var(--bg-main)',
          padding: 'calc(var(--safe-top) + 12px) 20px 14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        <button
          onClick={onBack}
          className="interactive glass-pill"
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

        <div
          className="glass-panel"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 14px',
            borderRadius: 'var(--radius-full)'
          }}
        >
          <SearchIcon size={18} color="var(--text-muted)" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search anime or movie..."
            onChange={(e) => handleSearch(e.target.value, false)}
            style={{
              flex: 1,
              backgroundColor: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              fontSize: '14px',
              fontWeight: 500
            }}
          />
          {query && (
            <button
              onClick={() => handleSearch('')}
              className="interactive"
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', display: 'flex' }}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Suggested Quick Tags */}
      <div style={{ padding: '14px 20px', display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {POPULAR_TAGS.map((tag) => {
          const active = query.toLowerCase() === tag.toLowerCase();
          return (
            <button
              key={tag}
              onClick={() => handleSearch(tag)}
              className={`interactive glass-pill chip ${active ? 'active' : ''}`}
              style={{
                padding: '6px 14px',
                borderRadius: 'var(--radius-full)',
                color: active ? undefined : 'var(--text-secondary)',
                fontSize: '12px',
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}
            >
              {tag}
            </button>
          );
        })}
      </div>

      {/* Results Header - only once there's an actual search to summarize */}
      {query && !loading && results.length > 0 && (
        <div style={{ padding: '0 20px 12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Results for "{query}"
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{results.length} results</span>
        </div>
      )}

      {/* Loading, empty prompt, no-results, or the results grid */}
      {searchFailed && !loading ? (
        <ErrorState
          message="Search couldn't reach the streaming site. Check your connection and try again."
          onRetry={() => runSearch(query)}
        />
      ) : loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '10px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} className="animate-spin" />
          <span style={{ fontSize: '14px' }}>Searching ani-cli database...</span>
        </div>
      ) : !query ? (
        <div style={{ padding: '4px 20px 0 20px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>Browse by Genre</h2>
          <div className="grid-genres">
            {genres.map((genre, i) => (
              <button
                key={genre.slug}
                onClick={() => onSelectGenre(genre)}
                className="interactive"
                style={{
                  height: '64px',
                  borderRadius: 'var(--radius-md)',
                  border: 'none',
                  padding: '0 14px',
                  display: 'flex',
                  alignItems: 'center',
                  background: `linear-gradient(135deg, ${GENRE_TILE_COLORS[i % GENRE_TILE_COLORS.length]} 0%, rgba(0,0,0,0.55) 140%)`,
                  color: '#fff',
                  fontSize: '15px',
                  fontWeight: 800,
                  textAlign: 'left'
                }}
              >
                {genre.name}
              </button>
            ))}
          </div>
        </div>
      ) : results.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>No anime found</p>
          <p style={{ fontSize: '13px' }}>Try searching with a different title or keyword.</p>
        </div>
      ) : (
        <div className="grid-posters" style={{ padding: '0 20px' }}>
          {results.map((anime) => (
            <div
              key={anime.id}
              onClick={() => onSelectAnime(anime)}
              className="interactive glass-panel"
              style={{
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <div style={{ position: 'relative', width: '100%', paddingTop: '140%', overflow: 'hidden' }}>
                <img
                  src={anime.poster}
                  alt={anime.title}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover'
                  }}
                />
                <div style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  backdropFilter: 'blur(8px)',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#e2e8f0'
                }}>
                  {anime.type || 'TV'}
                </div>
              </div>

              <div style={{ padding: '10px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <h3 style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  lineHeight: '1.3',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  marginBottom: '6px'
                }}>
                  {anime.title}
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {anime.subCount && (
                    <span style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      backgroundColor: 'rgba(99, 102, 241, 0.2)',
                      color: 'var(--accent-primary)',
                      padding: '2px 6px',
                      borderRadius: '4px'
                    }}>
                      SUB {anime.subCount}
                    </span>
                  )}
                  {anime.dubCount && (
                    <span style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      backgroundColor: 'rgba(168, 85, 247, 0.2)',
                      color: '#c084fc',
                      padding: '2px 6px',
                      borderRadius: '4px'
                    }}>
                      DUB {anime.dubCount}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
