import React, { useState, useEffect } from 'react';
import { Play, Flame, Clock, ChevronRight, ChevronDown, Bookmark, Search as SearchIcon } from 'lucide-react';
import { getTrendingAnime, type AnimeItem } from '../core/aniCliCore';
import { getWatchHistory, subscribeLibraryChanges, type WatchHistoryItem } from '../services/historyService';
import { getAnimeByGenre, getGenres, type Genre } from '../services/catalogService';
import { PosterCard } from '../components/PosterCard';
import { GenrePicker } from '../components/GenrePicker';

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

  useEffect(() => {
    let cancelled = false;
    getAnimeByGenre(genre, 1).then(page => {
      if (!cancelled) setItems(page.items.slice(0, 15));
    });
    return () => { cancelled = true; };
  }, [genre]);

  if (items && items.length === 0) return null;

  return (
    <div style={{ padding: '18px 0 4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', marginBottom: '10px' }}>
        <h2 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>{genre.name} Anime</h2>
        <button
          onClick={onSeeAll}
          className="interactive"
          style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}
        >
          <span>See all</span>
          <ChevronRight size={16} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', padding: '0 20px 6px 20px', scrollbarWidth: 'none' }}>
        {items
          ? items.map(anime => (
              <PosterCard key={anime.id} anime={anime} width={112} onClick={() => onSelectAnime(anime)} />
            ))
          : Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ flex: '0 0 112px', height: '162px', borderRadius: '6px' }} />
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

  const [featuredIndex, setFeaturedIndex] = useState<number>(0);
  const [history, setHistory] = useState<WatchHistoryItem[]>([]);
  const [trending, setTrending] = useState<AnimeItem[]>([]);
  const [loadingTrending, setLoadingTrending] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    getTrendingAnime().then(list => {
      if (cancelled) return;
      setTrending(list);
      setFeaturedIndex(0);
      setLoadingTrending(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Auto-cycle hero banner every 6 seconds - but not while the app is in
  // the background or a player covers the screen (this screen stays
  // mounted under the web player, and re-rendering the whole home feed
  // every 6s there costs frames during playback).
  useEffect(() => {
    if (trending.length < 2 || paused) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setFeaturedIndex(prev => (prev + 1) % Math.min(trending.length, 8));
    }, 6000);
    return () => clearInterval(timer);
  }, [trending, paused]);

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

  const heroAnime = trending[featuredIndex] || trending[0];

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '90px', position: 'relative' }}>
      {/* Top Mobile Bar */}
      <div 
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'linear-gradient(180deg, rgba(8,9,14,0.92) 0%, rgba(8,9,14,0.7) 70%, transparent 100%)',
          backdropFilter: 'blur(12px)',
          padding: 'calc(var(--safe-top) + 12px) 20px 12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '10px',
            background: 'var(--accent-gradient)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 16px rgba(99, 102, 241, 0.4)'
          }}>
            <Play size={16} color="#fff" fill="#fff" style={{ marginLeft: '2px' }} />
          </div>
          <div>
            <span style={{ fontSize: '19px', fontWeight: 800, letterSpacing: '-0.5px', color: '#fff' }}>Ani</span>
            <span style={{ fontSize: '19px', fontWeight: 800, background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Stream</span>
          </div>
        </div>

        {/* Sits on the hero banner image, so it keeps the dark-glass look
            regardless of app theme (same reasoning as the hero text below). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => setPickerOpen(true)}
            className="interactive glass-pill-dark"
            style={{
              padding: '7px 12px',
              borderRadius: 'var(--radius-full)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600
            }}
          >
            <span>Categories</span>
            <ChevronDown size={16} />
          </button>
          <button
            onClick={onOpenSearch}
            className="interactive glass-pill-dark"
            aria-label="Search"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff'
            }}
          >
            <SearchIcon size={18} />
          </button>
        </div>
      </div>

      {/* Cinematic Hero Carousel Banner */}
      {!heroAnime ? (
        <div
          className="skeleton"
          style={{ width: '100%', height: '420px', marginTop: '-60px' }}
        />
      ) : (
      <div style={{ position: 'relative', width: '100%', minHeight: '380px', marginTop: '-60px' }}>
        <img
          src={heroAnime.banner || heroAnime.poster}
          alt={heroAnime.title}
          style={{
            width: '100%',
            height: '420px',
            objectFit: 'cover',
            filter: 'brightness(0.75)'
          }}
        />
        {/* Soft Vignette Gradients */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(8,9,14,0.3) 0%, rgba(8,9,14,0.6) 50%, var(--bg-main) 100%)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: '24px 20px'
        }}>
          {/* Tag Badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{
              background: 'var(--accent-gradient)',
              color: '#fff',
              fontSize: '11px',
              fontWeight: 800,
              padding: '3px 9px',
              borderRadius: '6px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              #1 Trending
            </span>
            <span className="glass-pill-dark" style={{ fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '6px', color: '#cbd5e1' }}>
              {heroAnime.type || 'TV'}
            </span>
            {!!heroAnime.subCount && (
              <span className="glass-pill-dark" style={{ fontSize: '11px', fontWeight: 600, padding: '3px 8px', borderRadius: '6px', color: '#818cf8' }}>
                SUB: {heroAnime.subCount}
              </span>
            )}
          </div>

          <h1 style={{
            fontSize: '26px',
            fontWeight: 800,
            lineHeight: '1.2',
            color: '#fff',
            marginBottom: '8px',
            textShadow: '0 2px 10px rgba(0,0,0,0.8)'
          }}>
            {heroAnime.title}
          </h1>

          {heroAnime.description && (
            <p style={{
              fontSize: '13px',
              color: '#cbd5e1',
              lineHeight: '1.4',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              marginBottom: '16px',
              maxWidth: '90%'
            }}>
              {heroAnime.description}
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={() => onSelectAnime(heroAnime)}
              className="interactive"
              style={{
                flex: 1,
                padding: '12px 20px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent-gradient)',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                color: '#fff',
                fontSize: '15px',
                fontWeight: 700,
                boxShadow: 'var(--shadow-glow)'
              }}
            >
              <Play size={18} fill="#fff" />
              <span>Watch Now</span>
            </button>

            <button
              onClick={() => onSelectAnime(heroAnime)}
              className="interactive glass-pill-dark"
              style={{
                width: '46px',
                height: '46px',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff'
              }}
            >
              <Bookmark size={20} />
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Continue Watching Section */}
      {history.length > 0 && (
        <div style={{ padding: '24px 20px 8px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Clock size={18} color="var(--accent-primary)" />
              <h2 style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>Continue Watching</h2>
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{history.length} items</span>
          </div>

          <div style={{
            display: 'flex',
            gap: '14px',
            overflowX: 'auto',
            paddingBottom: '10px',
            scrollbarWidth: 'none'
          }}>
            {history.map((item) => {
              const progressPct = Math.min(100, Math.round((item.currentTime / (item.duration || 1)) * 100));
              return (
                <div
                  key={`${item.animeId}-${item.episodeId}`}
                  onClick={() => onResumeEpisode(item)}
                  className="interactive glass-panel"
                  style={{
                    flex: '0 0 200px',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    position: 'relative'
                  }}
                >
                  <div style={{ position: 'relative', height: '110px' }}>
                    <img
                      src={item.poster}
                      alt={item.animeTitle}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.85) 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(0,0,0,0.65)',
                        backdropFilter: 'blur(8px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Play size={16} fill="#fff" color="#fff" style={{ marginLeft: '2px' }} />
                      </div>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div style={{ width: '100%', height: '3px', backgroundColor: 'rgba(255,255,255,0.2)' }}>
                    <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--accent-gradient)' }} />
                  </div>

                  <div style={{ padding: '10px' }}>
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
                      Episode {item.episodeNumber} • {progressPct}% watched
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Flame size={18} color="#f43f5e" />
              <h2 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>Popular Anime</h2>
            </div>
            <button
              onClick={onOpenSearch}
              className="interactive"
              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}
            >
              <span>See all</span>
              <ChevronRight size={16} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', padding: '0 20px 6px 20px', scrollbarWidth: 'none' }}>
            {loadingTrending
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ flex: '0 0 112px', height: '162px', borderRadius: '6px' }} />
                ))
              : trending.map(anime => (
                  <PosterCard key={anime.id} anime={anime} width={112} onClick={() => onSelectAnime(anime)} />
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
