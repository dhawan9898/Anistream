// AnimeDetailScreen.tsx - Anime synopsis, episode grid, and sub/dub mode selector
import React, { useState, useEffect } from 'react';
import { ArrowLeft, Play, Bookmark, Loader2 } from 'lucide-react';
import { getEpisodes, type AnimeItem, type EpisodeItem } from '../core/aniCliCore';
import { toggleBookmark, getBookmarks, getUserPreferences } from '../services/historyService';

interface AnimeDetailScreenProps {
  anime: AnimeItem;
  onBack: () => void;
  onPlayEpisode: (episode: EpisodeItem, mode: 'sub' | 'dub') => void;
}

export const AnimeDetailScreen: React.FC<AnimeDetailScreenProps> = ({
  anime,
  onBack,
  onPlayEpisode
}) => {
  const [mode, setMode] = useState<'sub' | 'dub'>('sub');
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isBookmarked, setIsBookmarked] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<number>(0);

  useEffect(() => {
    // Check bookmark
    getBookmarks().then(bookmarks => {
      setIsBookmarked(bookmarks.some(b => b.id === anime.id));
    });

    // Respect the user's "Default Audio" preference instead of always
    // starting on SUB.
    getUserPreferences().then(p => setMode(p.defaultMode));

    // Fetch episodes - sort ascending by number so episodes[0] is genuinely
    // episode 1 rather than however the scraper happened to order the page.
    // (loading starts true and this effect only ever runs once per mount,
    // since App.tsx keys AnimeDetailScreen by anime id.)
    getEpisodes(anime.id).then((eps) => {
      const sorted = [...eps].sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
      setEpisodes(sorted);
      setLoading(false);
    });
  }, [anime.id]);

  const handleBookmarkToggle = async () => {
    const newState = await toggleBookmark(anime);
    setIsBookmarked(newState);
  };

  // Pagination for large episode lists (e.g., 50 per tab)
  const chunkSize = 50;
  const tabCount = Math.max(1, Math.ceil(episodes.length / chunkSize));
  const currentChunk = episodes.slice(activeTab * chunkSize, (activeTab + 1) * chunkSize);

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '90px', position: 'relative' }}>
      {/* Top Banner Backdrop */}
      <div style={{ position: 'relative', width: '100%', height: '280px' }}>
        <img
          src={anime.banner || anime.poster}
          alt={anime.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.6)' }}
        />
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(8,9,14,0.4) 0%, rgba(8,9,14,0.8) 70%, var(--bg-main) 100%)'
        }} />

        {/* Floating Top Nav - sits on the banner image, so (like the video
            player's popovers) it keeps the dark-glass look regardless of
            app theme rather than following the light/dark toggle. */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: 'calc(var(--safe-top) + 12px) 20px 0 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 20
        }}>
          <button
            onClick={onBack}
            className="interactive glass-pill-dark"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <ArrowLeft size={20} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={handleBookmarkToggle}
              className="interactive glass-pill-dark"
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isBookmarked ? 'var(--accent-danger)' : '#fff'
              }}
            >
              <Bookmark size={20} fill={isBookmarked ? 'var(--accent-danger)' : 'none'} />
            </button>
          </div>
        </div>
      </div>

      {/* Anime Info Section */}
      <div style={{ padding: '0 20px', marginTop: '-60px', position: 'relative', zIndex: 10 }}>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '16px' }}>
          <img
            src={anime.poster}
            alt={anime.title}
            style={{
              width: '110px',
              height: '160px',
              objectFit: 'cover',
              borderRadius: 'var(--radius-md)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
              border: '1px solid rgba(255,255,255,0.1)'
            }}
          />
          <div style={{ flex: 1, paddingBottom: '6px' }}>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              <span className="glass-pill" style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', color: 'var(--accent-primary)' }}>
                {anime.type || 'TV'}
              </span>
              <span className="glass-pill" style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', color: 'var(--accent-cyan)' }}>
                HD 1080p
              </span>
            </div>
            <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: '1.25' }}>
              {anime.title}
            </h1>
          </div>
        </div>

        {/* Sub / Dub Mode Switcher */}
        <div className="seg-track" style={{ marginBottom: '16px' }}>
          <button
            onClick={() => setMode('sub')}
            className={`interactive seg-pill ${mode === 'sub' ? 'active' : ''}`}
          >
            Subtitled (SUB)
          </button>
          <button
            onClick={() => setMode('dub')}
            className={`interactive seg-pill ${mode === 'dub' ? 'active' : ''}`}
          >
            Dubbed (DUB)
          </button>
        </div>

        {/* Description */}
        <p style={{
          fontSize: '13px',
          color: 'var(--text-secondary)',
          lineHeight: '1.5',
          marginBottom: '20px'
        }}>
          {anime.description || "Follow the extraordinary adventures in high quality, completely ad-free and powered directly by ani-cli streaming mechanics."}
        </p>

        {/* Quick Play Episode 1 Button */}
        {episodes.length > 0 && (
          <button
            onClick={() => onPlayEpisode(episodes[0], mode)}
            className="interactive"
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-gradient)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 700,
              boxShadow: 'var(--shadow-glow)',
              marginBottom: '24px'
            }}
          >
            <Play size={20} fill="#fff" />
            <span>Start Watching Episode 1 ({mode.toUpperCase()})</span>
          </button>
        )}

        {/* Episode List Header & Range Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Episodes</h2>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            {episodes.length} episodes available
          </span>
        </div>

        {/* Pagination tabs if more than 50 episodes */}
        {tabCount > 1 && (
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '12px', marginBottom: '10px' }}>
            {Array.from({ length: tabCount }).map((_, i) => {
              const start = i * chunkSize + 1;
              const end = Math.min(episodes.length, (i + 1) * chunkSize);
              return (
                <button
                  key={i}
                  onClick={() => setActiveTab(i)}
                  className={`interactive glass-pill chip ${activeTab === i ? 'active' : ''}`}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 'var(--radius-full)',
                    color: activeTab === i ? undefined : 'var(--text-secondary)',
                    fontSize: '12px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {start} - {end}
                </button>
              );
            })}
          </div>
        )}

        {/* Episodes Grid */}
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: '10px', color: 'var(--text-secondary)' }}>
            <Loader2 size={24} className="animate-spin" />
            <span style={{ fontSize: '14px' }}>Fetching episodes from ani-cli...</span>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '10px'
          }}>
            {currentChunk.map((ep) => (
              <button
                key={ep.id}
                onClick={() => onPlayEpisode(ep, mode)}
                className="interactive glass-panel"
                style={{
                  padding: '14px 8px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px'
                }}
              >
                <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {ep.number}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--accent-primary)', textTransform: 'uppercase', fontWeight: 600 }}>
                  Play
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
