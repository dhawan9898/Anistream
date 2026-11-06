// SearchScreen.tsx - Apple-style Spotlight search with quick topic chips,
// fluid squircle rows, and rapid live results.
import React, { useState, useEffect, useRef } from 'react';
import { Search as SearchIcon, X, Loader2, ArrowLeft, Play, Sparkles } from 'lucide-react';
import { getTrendingAnime, searchAnimeLive, type AnimeItem } from '../providers/aniCliCore';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { PosterCard } from '../components/PosterCard';
import { hapticLight, hapticSelection } from '../services/hapticsService';

const QUICK_TAGS = ['Solo Leveling', 'Jujutsu Kaisen', 'One Piece', 'Demon Slayer', 'Bleach', 'Chainsaw Man'];

interface SearchScreenProps {
  // True while this tab is the visible one (tabs stay mounted when hidden).
  active: boolean;
  onBack: () => void;
  onSelectAnime: (anime: AnimeItem) => void;
}

export const SearchScreen: React.FC<SearchScreenProps> = ({
  active,
  onBack,
  onSelectAnime
}) => {
  // Shown while the box is empty, like Netflix/Apple "Top Searches".
  const [topSearches, setTopSearches] = useState<AnimeItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    getTrendingAnime()
      .then(list => { if (!cancelled) setTopSearches(list.slice(0, 12)); })
      .catch(() => { /* the empty state simply stays blank */ });
    return () => { cancelled = true; };
  }, []);

  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<AnimeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the field when the tab is opened.
  useEffect(() => {
    if (!active) {
      inputRef.current?.blur();
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 260);
    return () => window.clearTimeout(timer);
  }, [active]);

  const searchSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    searchSeq.current++;
  }, []);

  const runSearch = async (searchTerm: string) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    setSearchError(false);
    try {
      const list = await searchAnimeLive(searchTerm);
      if (seq === searchSeq.current) setResults(list);
    } catch (err) {
      console.warn('[SearchScreen] search failed:', err);
      if (seq === searchSeq.current) {
        setResults([]);
        setSearchError(true);
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
      setSearchError(false);
      return;
    }
    if (immediate) {
      runSearch(searchTerm);
    } else {
      setLoading(true);
      debounceTimer.current = setTimeout(() => runSearch(searchTerm), 320);
    }
  };

  return (
    <div className="screen-scroll" style={{ paddingBottom: '108px', display: 'flex', flexDirection: 'column' }}>
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
          borderBottom: '1px solid var(--border-subtle)',
          WebkitBackdropFilter: 'var(--glass-blur)',
          backdropFilter: 'var(--glass-blur)'
        }}
      >
        <button
          onClick={() => { hapticLight(); onBack(); }}
          aria-label="Back to Home"
          className="interactive glass-pill-dark"
          style={{
            width: '40px',
            height: '40px',
            borderRadius: 'var(--radius-pill)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            color: 'var(--text-primary)',
            flexShrink: 0
          }}
        >
          <ArrowLeft size={19} />
        </button>

        <div
          className="glass-panel"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 16px',
            borderRadius: 'var(--radius-pill)',
            border: '1.5px solid var(--border-subtle)',
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.18)'
          }}
        >
          <SearchIcon size={18} color="var(--text-muted)" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search shows, movies, genres…"
            aria-label="Search anime"
            enterKeyHint="search"
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
              onClick={() => { hapticLight(); handleSearch(''); }}
              className="interactive"
              aria-label="Clear search"
              style={{
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: 'rgba(120, 120, 128, 0.3)',
                border: 'none',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Quick Search Suggestions Chips */}
      {!query && (
        <div className="rail" style={{ gap: '8px', padding: '14px 20px 6px 20px' }}>
          {QUICK_TAGS.map(tag => (
            <button
              key={tag}
              onClick={() => { hapticSelection(); handleSearch(tag, true); }}
              className="interactive glass-pill"
              style={{
                padding: '7px 14px',
                borderRadius: 'var(--radius-pill)',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <Sparkles size={12} color="var(--accent-primary)" />
              <span>{tag}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '10px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} className="animate-spin" color="var(--accent-primary)" />
          <span style={{ fontSize: '14px', fontWeight: 600 }}>Searching titles…</span>
        </div>
      ) : !query ? (
        <div style={{ padding: '16px 20px 0 20px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px', letterSpacing: '-0.3px' }}>
            Top Searches
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {topSearches.length === 0 && Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: '72px', borderRadius: 'var(--radius-md)' }} />
            ))}
            {topSearches.map(anime => (
              <button
                key={anime.id}
                onClick={() => onSelectAnime(anime)}
                className="interactive card-bouncy glass-panel"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  textAlign: 'left',
                  color: 'var(--text-primary)'
                }}
              >
                <div style={{
                  position: 'relative',
                  width: '110px',
                  height: '66px',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  flexShrink: 0,
                  backgroundColor: 'rgba(127,127,127,0.15)'
                }}>
                  <FadeImage src={anime.banner || anime.poster} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    lineHeight: 1.35,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {anime.title}
                  </span>
                  {anime.type && (
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px', display: 'block' }}>
                      {anime.type}
                    </span>
                  )}
                </div>
                <span style={{
                  width: '36px',
                  height: '36px',
                  margin: '0 8px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  border: '1.5px solid rgba(255,255,255,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}>
                  <Play size={14} fill="currentColor" color="currentColor" style={{ marginLeft: '2px' }} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : searchError ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Couldn't reach the server</p>
          <p style={{ fontSize: '13px', marginBottom: '18px' }}>Check your network connection and retry.</p>
          <button
            onClick={() => handleSearch(query)}
            className="interactive glass-pill"
            style={{ padding: '10px 24px', borderRadius: 'var(--radius-pill)', fontSize: '13px', fontWeight: 700, background: 'var(--accent-primary)', color: '#fff', border: 'none' }}
          >
            Retry Search
          </button>
        </div>
      ) : results.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 28px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>No results for "{query}"</p>
          <p style={{ fontSize: '13px' }}>Try searching with a broader title or character name.</p>
        </div>
      ) : (
        <div style={{ padding: '16px 20px 0 20px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px', letterSpacing: '-0.3px' }}>
            Results ({results.length})
          </h2>
          <div className="grid-collection">
            {results.map(anime => (
              <PosterCard key={anime.id} anime={anime} onSelect={onSelectAnime} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
