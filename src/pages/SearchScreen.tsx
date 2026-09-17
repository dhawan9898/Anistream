// SearchScreen.tsx - Rapid anime search powered by ani-cli scraper
import React, { useState, useEffect, useRef } from 'react';
import { Search as SearchIcon, X, Loader2, ArrowLeft, TrendingUp } from 'lucide-react';
import { searchAnime, FEATURED_ANIME, type AnimeItem } from '../core/aniCliCore';

interface SearchScreenProps {
  onBack: () => void;
  onSelectAnime: (anime: AnimeItem) => void;
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
  onSelectAnime
}) => {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<AnimeItem[]>(FEATURED_ANIME);
  const [loading, setLoading] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSearch = async (searchTerm: string) => {
    setQuery(searchTerm);
    if (!searchTerm.trim()) {
      setResults(FEATURED_ANIME);
      return;
    }

    setLoading(true);
    const list = await searchAnime(searchTerm);
    setResults(list);
    setLoading(false);
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
            onChange={(e) => handleSearch(e.target.value)}
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

      {/* Results Header */}
      <div style={{ padding: '0 20px 12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <TrendingUp size={16} color="var(--accent-primary)" />
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {query ? `Results for "${query}"` : "Top Trending Anime"}
          </span>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{results.length} results</span>
      </div>

      {/* Loading or Results Grid */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '10px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} className="animate-spin" />
          <span style={{ fontSize: '14px' }}>Searching ani-cli database...</span>
        </div>
      ) : results.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>No anime found</p>
          <p style={{ fontSize: '13px' }}>Try searching with a different title or keyword.</p>
        </div>
      ) : (
        <div style={{
          padding: '0 20px',
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '14px'
        }}>
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
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    backgroundColor: 'rgba(99, 102, 241, 0.2)',
                    color: '#818cf8',
                    padding: '2px 6px',
                    borderRadius: '4px'
                  }}>
                    SUB {anime.subCount || 12}
                  </span>
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
