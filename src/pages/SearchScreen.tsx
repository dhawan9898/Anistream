// SearchScreen.tsx - Rapid anime search powered by ani-cli scraper
import React, { useState, useEffect, useRef } from 'react';
import { Search as SearchIcon, X, Loader2, ArrowLeft, Play } from 'lucide-react';
import { getTrendingAnime, searchAnimeLive, type AnimeItem } from '../core/aniCliCore';
import { FadeImage } from '../components/FadeImage';
import { PosterCard } from '../components/PosterCard';

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
  // Shown while the box is empty, like Netflix's "Top Searches".
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

  // Focus the field (raising the keyboard) when the tab is opened - after
  // the tab's fade-in, so the keyboard animation doesn't fight it - and put
  // the keyboard away again when the tab is left.
  useEffect(() => {
    if (!active) {
      inputRef.current?.blur();
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 260);
    return () => window.clearTimeout(timer);
  }, [active]);

  // Typing is debounced and only the newest request may update the screen,
  // so a slow response for an earlier keystroke can't overwrite newer results.
  const searchSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    searchSeq.current++;
  }, []);

  // Live results only: the old path silently swapped in made-up "results"
  // when the site was unreachable, which looked like real anime that then
  // failed to play. A failure is now shown as such, with a retry.
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
      debounceTimer.current = setTimeout(() => runSearch(searchTerm), 350);
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
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        <button
          onClick={onBack}
          aria-label="Back to Home"
          className="interactive"
          style={{
            width: '40px',
            height: '40px',
            margin: '0 -8px',
            background: 'none',
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
            borderRadius: '4px'
          }}
        >
          <SearchIcon size={18} color="var(--text-muted)" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search for a show, movie, genre…"
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
              onClick={() => handleSearch('')}
              className="interactive"
              aria-label="Clear search"
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', display: 'flex' }}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '10px', color: 'var(--text-secondary)' }}>
          <Loader2 size={24} className="animate-spin" />
          <span style={{ fontSize: '14px' }}>Searching…</span>
        </div>
      ) : !query ? (
        <div style={{ padding: '18px 20px 0 20px' }}>
          <h2 style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>Top Searches</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {topSearches.length === 0 && Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: '68px', borderRadius: '4px' }} />
            ))}
            {topSearches.map(anime => (
              <button
                key={anime.id}
                onClick={() => onSelectAnime(anime)}
                className="interactive"
                style={{ display: 'flex', alignItems: 'center', gap: '14px', background: 'var(--bg-surface)', border: 'none', borderRadius: '4px', padding: 0, overflow: 'hidden', textAlign: 'left', color: 'var(--text-primary)' }}
              >
                <div style={{ position: 'relative', width: '120px', height: '68px', flexShrink: 0, backgroundColor: 'rgba(127,127,127,0.15)' }}>
                  <FadeImage src={anime.banner || anime.poster} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <span style={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 700, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {anime.title}
                </span>
                <span style={{ width: '34px', height: '34px', margin: '0 14px 0 4px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Play size={14} fill="#fff" color="#fff" style={{ marginLeft: '2px' }} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : searchError ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>Couldn't reach the server</p>
          <p style={{ fontSize: '13px', marginBottom: '16px' }}>Check your connection and try again.</p>
          <button
            onClick={() => handleSearch(query)}
            className="interactive glass-pill chip active"
            style={{ padding: '10px 22px', borderRadius: '4px', fontSize: '13px', fontWeight: 700 }}
          >
            Retry
          </button>
        </div>
      ) : results.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 28px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>No results for "{query}"</p>
          <p style={{ fontSize: '13px' }}>Try searching for another title or keyword.</p>
        </div>
      ) : (
        <div style={{ padding: '16px 16px 0 16px' }}>
          <h2 style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>Anime</h2>
          <div className="grid-collection">
            {results.map(anime => (
              <PosterCard key={anime.id} anime={anime} onClick={() => onSelectAnime(anime)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
