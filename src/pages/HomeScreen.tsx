import React, { useState, useEffect, useRef } from 'react';
import { Play, ChevronRight, ChevronDown, Search as SearchIcon } from 'lucide-react';
import { getTrendingAnime, type AnimeItem } from '../providers/aniCliCore';
import { getWatchHistory, isEpisodeFinished, subscribeLibraryChanges, type WatchHistoryItem } from '../services/historyService';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { getAnimeByGenre, getGenres, type Genre } from '../providers/catalogService';
import { PosterCard } from '../components/PosterCard';
import { GenrePicker } from '../components/GenrePicker';
import { HeroCarousel } from '../components/HeroCarousel';
import { ErrorState } from 'streamkit/ui/ErrorState.tsx';
import { hapticLight, hapticMedium } from '../services/hapticsService';

// Genres that get their own rail on the home screen, Netflix-style.
const HOME_ROW_GENRES = ['action', 'romance', 'comedy', 'fantasy', 'isekai'];

// One horizontally scrolling genre rail with a "See all" link into the
// full genre page.
const GenreRow: React.FC<{
  genre: Genre;
  onSelectAnime: (anime: AnimeItem) => void;
  onSeeAll: () => void;
}> = ({ genre, onSelectAnime, onSeeAll }) => {
  const [items, setItems] = useState<AnimeItem[] | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Rails are only fetched once they are near the screen, so opening the app
  // doesn't fire a request per rail while most are far below the fold.
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '600px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    getAnimeByGenre(genre, 1).then(page => {
      if (!cancelled) setItems(page.items.slice(0, 15));
    }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [genre, near]);

  if (items && items.length === 0) return null;

  return (
    <div ref={rootRef} style={{ padding: '18px 0 4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', marginBottom: '10px' }}>
        <h2 style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>{genre.name} Anime</h2>
        <button
          onClick={() => { hapticLight(); onSeeAll(); }}
          className="interactive"
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}
        >
          <span>See all</span>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="rail" style={{ gap: '12px', padding: '0 20px 8px 20px' }}>
        {items
          ? items.map(anime => (
              <PosterCard key={anime.id} anime={anime} width={118} onSelect={onSelectAnime} />
            ))
          : Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ flex: '0 0 118px', height: '168px', borderRadius: 'var(--radius-md)' }} />
            ))}
      </div>
    </div>
  );
};

interface HomeScreenProps {
  onSelectAnime: (anime: AnimeItem) => void;
  onResumeEpisode: (history: WatchHistoryItem) => void;
  onOpenSearch: () => void;
  onSelectGenre: (genre: Genre) => void;
  // True while a player covers this screen.
  paused?: boolean;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  onSelectAnime,
  onResumeEpisode,
  onOpenSearch,
  onSelectGenre,
  paused = false
}) => {
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [rowGenres, setRowGenres] = useState<Genre[]>([]);

  useEffect(() => {
    getGenres().then(all => {
      setRowGenres(HOME_ROW_GENRES.map(slug => all.find(g => g.slug === slug)).filter(Boolean) as Genre[]);
    });
  }, []);

  const [history, setHistory] = useState<WatchHistoryItem[]>([]);
  const [trending, setTrending] = useState<AnimeItem[]>([]);
  const [loadingTrending, setLoadingTrending] = useState<boolean>(true);
  const [trendingError, setTrendingError] = useState<boolean>(false);
  const [trendingAttempt, setTrendingAttempt] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    getTrendingAnime()
      .then(list => {
        if (cancelled) return;
        setTrending(list);
        setTrendingError(false);
      })
      .catch(err => {
        console.warn('[HomeScreen] trending feed failed:', err);
        if (!cancelled) setTrendingError(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingTrending(false);
      });
    return () => { cancelled = true; };
  }, [trendingAttempt]);

  const retryTrending = () => {
    setTrendingError(false);
    setLoadingTrending(true);
    setTrendingAttempt(n => n + 1);
  };

  // Continue Watching stays current: it follows library changes while this
  // screen is visible, and reloads once when the player covering it closes
  // (not on every progress save during playback, which would re-render the
  // whole feed under the video every few seconds).
  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const load = () => getWatchHistory().then(list => { if (!cancelled) setHistory(list); });
    load();
    const unsubscribe = subscribeLibraryChanges(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [paused]);

  return (
    <div className="screen-scroll" style={{ paddingBottom: '108px', position: 'relative' }}>
      {/* Top Mobile Bar */}
      <div 
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'rgba(11, 11, 14, 0.82)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          backdropFilter: 'blur(20px) saturate(180%)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          padding: 'calc(var(--safe-top) + 12px) 20px 12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}
      >
        <span style={{ fontSize: '24px', fontWeight: 900, letterSpacing: '-0.8px', textShadow: '0 2px 14px rgba(0,0,0,0.7)', userSelect: 'none' }}>
          <span style={{ color: '#ff2d3b' }}>ANI</span>
          <span style={{ color: '#ffffff' }}>STREAM</span>
        </span>

        {/* Sits on the hero banner image, so it keeps the dark look regardless
            of app theme (same reasoning as the hero text below). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => { hapticLight(); setPickerOpen(true); }}
            className="interactive glass-pill-dark"
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--radius-pill)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
            }}
          >
            <span>Categories</span>
            <ChevronDown size={15} />
          </button>
          <button
            onClick={() => { hapticLight(); onOpenSearch(); }}
            className="interactive glass-pill-dark"
            aria-label="Search"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: 'var(--radius-pill)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
            }}
          >
            <SearchIcon size={19} />
          </button>
        </div>
      </div>

      {/* Featured titles - swipeable, auto-advancing (Netflix hero) */}
      {trendingError ? (
        <div style={{ paddingTop: 'calc(var(--safe-top) + 40px)' }}>
          <ErrorState
            message="Couldn't reach the streaming site. Check your connection and try again."
            onRetry={retryTrending}
          />
        </div>
      ) : (
        <HeroCarousel items={trending} onSelect={onSelectAnime} paused={paused} />
      )}

      {/* Continue Watching Section */}
      {history.length > 0 && (
        <div style={{ padding: '24px 20px 8px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>Continue Watching</h2>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>{history.length} {history.length === 1 ? 'title' : 'titles'}</span>
          </div>

          <div className="rail" style={{ gap: '14px', paddingBottom: '12px' }}>
            {history.map((item) => {
              const progressPct = Math.min(100, Math.round((item.currentTime / (item.duration || 1)) * 100));
              const finished = isEpisodeFinished(item);
              const minutesLeft = Math.max(1, Math.round((item.duration - item.currentTime) / 60));
              return (
                <div
                  key={`${item.animeId}-${item.episodeId}`}
                  onClick={() => { hapticMedium(); onResumeEpisode(item); }}
                  className="interactive card-bouncy glass-panel"
                  style={{
                    flex: '0 0 214px',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    position: 'relative'
                  }}
                >
                  <div style={{ position: 'relative', height: '116px' }}>
                    <FadeImage
                      src={item.poster}
                      alt={item.animeTitle}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.78) 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <div style={{
                        width: '38px',
                        height: '38px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(15,15,20,0.7)',
                        WebkitBackdropFilter: 'blur(10px)',
                        backdropFilter: 'blur(10px)',
                        border: '1.5px solid rgba(255,255,255,0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.45)'
                      }}>
                        <Play size={16} fill="#fff" color="#fff" style={{ marginLeft: '2px' }} />
                      </div>
                    </div>
                  </div>

                  {/* Sleek Apple-style progress bar */}
                  <div style={{ width: '100%', height: '3.5px', backgroundColor: 'rgba(255,255,255,0.15)' }}>
                    <div style={{
                      width: `${progressPct}%`,
                      height: '100%',
                      background: 'var(--accent-bar)',
                      boxShadow: '0 0 8px var(--accent-shadow)'
                    }} />
                  </div>

                  <div style={{ padding: '12px 14px' }}>
                    <h4 style={{
                      fontSize: '13px',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {item.animeTitle}
                    </h4>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {finished
                        ? `Finished E${item.episodeNumber} · Up next`
                        : `E${item.episodeNumber} · ${minutesLeft}m left`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Popular Anime - first rail, same horizontal row style as the
          genre rails below it */}
      {(loadingTrending || trending.length > 0) && (
        <div style={{ padding: '18px 0 4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', marginBottom: '10px' }}>
            <h2 style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>Popular Anime</h2>
            <button
              onClick={onOpenSearch}
              className="interactive"
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}
            >
              <span>See all</span>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="rail" style={{ gap: '10px', padding: '0 20px 6px 20px' }}>
            {loadingTrending
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ flex: '0 0 112px', height: '162px', borderRadius: '4px' }} />
                ))
              : trending.map(anime => (
                  <PosterCard key={anime.id} anime={anime} width={112} onSelect={onSelectAnime} />
                ))}
          </div>
        </div>
      )}

      {/* Genre rails */}
      {rowGenres.map(genre => (
        <GenreRow
          key={genre.slug}
          genre={genre}
          onSelectAnime={onSelectAnime}
          onSeeAll={() => onSelectGenre(genre)}
        />
      ))}

      <GenrePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(genre) => {
          setPickerOpen(false);
          onSelectGenre(genre);
        }}
      />
    </div>
  );
};
