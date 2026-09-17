import React, { useState, useEffect } from 'react';
import { Play, Flame, Clock, ChevronRight, Bookmark } from 'lucide-react';
import { FEATURED_ANIME, getTrendingAnime, type AnimeItem } from '../core/aniCliCore';
import { getWatchHistory, type WatchHistoryItem } from '../services/historyService';

interface HomeScreenProps {
  onSelectAnime: (anime: AnimeItem) => void;
  onResumeEpisode: (history: WatchHistoryItem) => void;
  onOpenSearch: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  onSelectAnime,
  onResumeEpisode,
  onOpenSearch
}) => {
  const [featuredIndex, setFeaturedIndex] = useState<number>(0);
  const [history, setHistory] = useState<WatchHistoryItem[]>([]);
  const [trending, setTrending] = useState<AnimeItem[]>(FEATURED_ANIME);

  useEffect(() => {
    getTrendingAnime().then(list => {
      setTrending(list);
      setFeaturedIndex(0);
    });
  }, []);

  // Auto-cycle hero banner every 6 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setFeaturedIndex(prev => (prev + 1) % (Math.min(trending.length, 8) || 1));
    }, 6000);
    return () => clearInterval(timer);
  }, [trending]);

  useEffect(() => {
    getWatchHistory().then(setHistory);
  }, []);

  const heroAnime = trending[featuredIndex] || trending[0] || FEATURED_ANIME[0];

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
        <button
          onClick={onOpenSearch}
          className="interactive glass-pill-dark"
          style={{
            padding: '7px 14px',
            borderRadius: 'var(--radius-full)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            color: '#cbd5e1',
            fontSize: '13px',
            fontWeight: 500
          }}
        >
          <span>Search anime...</span>
        </button>
      </div>

      {/* Cinematic Hero Carousel Banner */}
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
            {heroAnime.subCount && (
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
            {history.map((item, idx) => {
              const progressPct = Math.min(100, Math.round((item.currentTime / (item.duration || 1)) * 100));
              return (
                <div
                  key={idx}
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

      {/* Trending Anime Grid */}
      <div style={{ padding: '20px 20px 10px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Flame size={20} color="#f43f5e" />
            <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Popular Anime</h2>
          </div>
          <button 
            onClick={onOpenSearch}
            className="interactive"
            style={{ background: 'none', border: 'none', color: '#6366f1', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}
          >
            <span>Explore all</span>
            <ChevronRight size={16} />
          </button>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '14px'
        }}>
          {trending.map((anime) => (
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

                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: '40px',
                  background: 'linear-gradient(180deg, transparent 0%, rgba(8,9,14,0.95) 100%)'
                }} />
              </div>

              <div style={{ padding: '10px 10px 12px 10px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
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
      </div>
    </div>
  );
};
