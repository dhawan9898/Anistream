// HistoryScreen.tsx - User watch history, bookmarks, and preferences
import React, { useState, useEffect } from 'react';
import { Clock, Bookmark, Trash2, Play, Loader2, X } from 'lucide-react';
import {
  getWatchHistory, clearWatchHistory, removeWatchHistoryItem, getBookmarks,
  subscribeLibraryChanges, type WatchHistoryItem
} from '../services/historyService';
import type { AnimeItem } from '../core/aniCliCore';
import { ConfirmModal } from '../components/ConfirmModal';
import { FadeImage } from '../components/FadeImage';

interface HistoryScreenProps {
  // True while this tab is the visible one (tabs stay mounted when hidden).
  active: boolean;
  onResumeEpisode: (history: WatchHistoryItem) => void;
  onSelectAnime: (anime: AnimeItem) => void;
}

export const HistoryScreen: React.FC<HistoryScreenProps> = ({
  active,
  onResumeEpisode,
  onSelectAnime
}) => {
  const [activeTab, setActiveTab] = useState<'history' | 'bookmarks'>('history');
  const [historyList, setHistoryList] = useState<WatchHistoryItem[]>([]);
  const [bookmarkedAnime, setBookmarkedAnime] = useState<AnimeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmingClear, setConfirmingClear] = useState<boolean>(false);

  // Reloaded whenever the tab is opened and whenever history/bookmarks change
  // while it is visible (hidden tabs stay quiet).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const loadData = async () => {
      const [history, bookmarks] = await Promise.all([getWatchHistory(), getBookmarks()]);
      if (cancelled) return;
      setHistoryList(history);
      setBookmarkedAnime(bookmarks);
      setLoading(false);
    };
    loadData();
    const unsubscribe = subscribeLibraryChanges(loadData);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active]);

  const handleClearHistory = async () => {
    await clearWatchHistory();
    setHistoryList([]);
    setConfirmingClear(false);
  };

  const handleRemoveItem = async (e: React.MouseEvent, animeId: string) => {
    e.stopPropagation(); // don't trigger onResumeEpisode on the card underneath
    const updated = await removeWatchHistoryItem(animeId);
    setHistoryList(updated);
  };

  return (
    <div className="screen-scroll" style={{ paddingBottom: '110px' }}>
      {/* Top Header */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        backgroundColor: 'var(--bg-main)',
        padding: 'calc(var(--safe-top) + 16px) 20px 14px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-subtle)'
      }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>My Library</h1>
        
        {activeTab === 'history' && historyList.length > 0 && (
          <button
            onClick={() => setConfirmingClear(true)}
            className="interactive"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-danger)',
              fontSize: '13px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Trash2 size={16} />
            <span>Clear</span>
          </button>
        )}
      </div>

      <ConfirmModal
        open={confirmingClear}
        title="Clear Watch History"
        message="Are you sure you want to clear your watch history? This cannot be undone."
        confirmLabel="Clear"
        cancelLabel="Cancel"
        danger
        onConfirm={handleClearHistory}
        onCancel={() => setConfirmingClear(false)}
      />

      {/* Tabs */}
      <div style={{ padding: '16px 20px 8px 20px' }}>
        <div className="seg-track">
          <button
            onClick={() => setActiveTab('history')}
            className={`interactive seg-pill ${activeTab === 'history' ? 'active' : ''}`}
          >
            <Clock size={16} />
            <span>History ({historyList.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('bookmarks')}
            className={`interactive seg-pill ${activeTab === 'bookmarks' ? 'active' : ''}`}
          >
            <Bookmark size={16} />
            <span>My List ({bookmarkedAnime.length})</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '12px 20px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '10px', color: 'var(--text-secondary)' }}>
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : activeTab === 'history' ? (
          historyList.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
              <Clock size={40} color="var(--accent-primary)" style={{ margin: '0 auto 12px auto', opacity: 0.8 }} />
              <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>No watch history</p>
              <p style={{ fontSize: '13px' }}>Anime episodes you stream will appear here so you can easily resume.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {historyList.map((item) => {
                const progressPct = Math.min(100, Math.round((item.currentTime / (item.duration || 1)) * 100));
                return (
                  <div
                    key={`${item.animeId}-${item.episodeId}`}
                    onClick={() => onResumeEpisode(item)}
                    className="interactive glass-panel"
                    style={{
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                      display: 'flex',
                      gap: '14px',
                      padding: '10px',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ position: 'relative', width: '80px', height: '60px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0 }}>
                      <FadeImage src={item.poster} alt={item.animeTitle} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        backgroundColor: 'rgba(0,0,0,0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Play size={16} fill="#fff" color="#fff" />
                      </div>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px', backgroundColor: 'rgba(255,255,255,0.2)' }}>
                        <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--accent-gradient)' }} />
                      </div>
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.animeTitle}
                      </h3>
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Episode {item.episodeNumber} • {progressPct}% watched
                      </p>
                    </div>

                    <button
                      onClick={(e) => handleRemoveItem(e, item.animeId)}
                      className="interactive"
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: 'none',
                        background: 'none',
                        color: 'var(--text-muted)',
                        flexShrink: 0
                      }}
                      aria-label={`Remove ${item.animeTitle} from history`}
                    >
                      <X size={18} />
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          bookmarkedAnime.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
              <Bookmark size={40} color="var(--accent-secondary)" style={{ margin: '0 auto 12px auto', opacity: 0.8 }} />
              <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>Your list is empty</p>
              <p style={{ fontSize: '13px' }}>Tap “My List” on any title to save it here.</p>
            </div>
          ) : (
            <div className="grid-posters">
              {bookmarkedAnime.map((anime) => (
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
                    <FadeImage
                      src={anime.poster}
                      alt={anime.title}
                      loading="lazy"
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                  <div style={{ padding: '10px' }}>
                    <h3 style={{
                      fontSize: '14px',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {anime.title}
                    </h3>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};
