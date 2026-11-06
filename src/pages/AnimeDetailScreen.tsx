import React, { useState, useEffect } from 'react';
import { ArrowLeft, Play, Bookmark, Check, Loader2 } from 'lucide-react';
import { FadeImage } from 'streamkit/ui/FadeImage.tsx';
import { ErrorState } from 'streamkit/ui/ErrorState.tsx';
import { getEpisodes, type AnimeItem, type EpisodeItem } from '../providers/aniCliCore';
import {
  toggleBookmark,
  getBookmarks,
  getUserPreferences,
  getWatchHistory,
  getEpisodeProgress,
  episodeWatchState,
  isEpisodeFinished,
  type EpisodeProgress,
  subscribeLibraryChanges,
  type WatchHistoryItem
} from '../services/historyService';
import { getAnimeDetails, hasDub, resolveAnime, type AnimeDetails } from '../providers/catalogService';
import { PosterCard } from '../components/PosterCard';
import { DownloadButton } from '../components/DownloadButton';
import { downloadsSupported, downloadId, startDownload, removeDownload } from '../services/downloadService';
import { useDownloads } from '../services/useDownloads';
import { hapticLight, hapticMedium, hapticSuccess, hapticSelection } from '../services/hapticsService';

interface AnimeDetailScreenProps {
  anime: AnimeItem;
  onBack: () => void;
  // `anime` is the resolved streaming-site entry, which can differ from the
  // prop when this page was opened from a MyAnimeList-backed suggestion.
  onPlayEpisode: (anime: AnimeItem, episode: EpisodeItem, mode: 'sub' | 'dub') => void;
  onResume: (anime: AnimeItem, history: WatchHistoryItem) => void;
  onSelectAnime: (anime: AnimeItem) => void;
}

type DetailTab = 'episodes' | 'collection' | 'similar';

export const AnimeDetailScreen: React.FC<AnimeDetailScreenProps> = ({
  anime,
  onBack,
  onPlayEpisode,
  onResume,
  onSelectAnime
}) => {
  const [resolved, setResolved] = useState<AnimeItem | null>(/^(al|mal)-/.test(anime.id) ? null : anime);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [mode, setMode] = useState<'sub' | 'dub'>('sub');
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [episodesError, setEpisodesError] = useState<boolean>(false);
  const [episodesAttempt, setEpisodesAttempt] = useState<number>(0);
  const [isBookmarked, setIsBookmarked] = useState<boolean>(false);
  // null = not picked by the user yet; see autoRange below.
  const [pickedRange, setActiveRange] = useState<number | null>(null);
  const [details, setDetails] = useState<AnimeDetails | null>(null);
  const [tab, setTab] = useState<DetailTab>('episodes');
  const [history, setHistory] = useState<WatchHistoryItem | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);
  const downloads = useDownloads();
  const canDownload = downloadsSupported();
  // Whether an English dub exists: undefined until known (the option stays
  // visible meanwhile), false hides it everywhere.
  const [dubAvailable, setDubAvailable] = useState<boolean | undefined>(
    anime.dubCount !== undefined ? anime.dubCount > 0 : undefined
  );
  const [progress, setProgress] = useState<Record<string, EpisodeProgress>>({});
  // The page slides in over the previous one; the heavy lower half (episode
  // grid, posters) is built only once that slide has finished, so the
  // animation never competes with layout work.
  const [settled, setSettled] = useState<boolean>(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 340);
    return () => window.clearTimeout(timer);
  }, []);

  // Respect the user's "Default Audio" preference instead of always
  // starting on SUB.
  useEffect(() => {
    let cancelled = false;
    getUserPreferences().then(p => { if (!cancelled) setMode(p.defaultMode); });
    return () => { cancelled = true; };
  }, []);

  // AniList-backed entries (opened from a suggestion) first need their
  // real streaming-site entry. (App keys this screen by anime id, so this
  // runs once per title.)
  useEffect(() => {
    if (resolved) return;
    let cancelled = false;
    resolveAnime(anime)
      .then(item => { if (!cancelled) setResolved(item); })
      .catch(err => {
        if (cancelled) return;
        console.warn('[AnimeDetailScreen] resolve failed:', err);
        setResolveError(`"${anime.title}" isn't available to stream right now.`);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [anime, resolved]);

  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;

    // This page stays mounted under the player, so Resume/My List follow
    // library changes instead of showing what was stored when it opened.
    const loadLibrary = () => {
      getBookmarks().then(bookmarks => {
        if (!cancelled) setIsBookmarked(bookmarks.some(b => b.id === resolved.id));
      });
      getWatchHistory().then(list => {
        if (!cancelled) setHistory(list.find(h => h.animeId === resolved.id) || null);
      });
      getEpisodeProgress(resolved.id).then(map => {
        if (!cancelled) setProgress(map);
      });
    };
    loadLibrary();
    const unsubscribe = subscribeLibraryChanges(loadLibrary);

    getAnimeDetails(resolved).then(d => {
      if (!cancelled) {
        setDetails(d);
        if (resolved.dubCount !== undefined) {
          setDubAvailable(resolved.dubCount > 0);
        }
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [resolved]);

  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;
    hasDub(resolved).then(known => { if (!cancelled && known !== undefined) setDubAvailable(known); });
    return () => { cancelled = true; };
  }, [resolved]);

  // Episodes load on their own so a failure can be retried by itself.
  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;
    // Sort ascending by number so episodes[0] is genuinely episode 1 rather
    // than however the scraper happened to order the page.
    getEpisodes(resolved.id)
      .then((eps) => {
        if (cancelled) return;
        setEpisodes([...eps].sort((a, b) => parseFloat(a.number) - parseFloat(b.number)));
        setEpisodesError(false);
      })
      .catch(err => {
        console.warn('[AnimeDetailScreen] episode list failed:', err);
        if (!cancelled) setEpisodesError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [resolved, episodesAttempt]);

  const retryEpisodes = () => {
    setEpisodesError(false);
    setLoading(true);
    setEpisodesAttempt(n => n + 1);
  };

  const shown = resolved || anime;
  // Respect user's last choice of language (from title history or preferences)
  const playMode: 'sub' | 'dub' = dubAvailable === false ? 'sub' : (history?.mode || mode);
  // What the player is told about the title (it hides its own dub option too).
  const playAnime = resolved
    ? { ...resolved, dubCount: dubAvailable === undefined ? resolved.dubCount : dubAvailable ? (resolved.dubCount || 1) : 0 }
    : null;

  const handleBookmarkToggle = async () => {
    if (!resolved) return;
    const nowSaved = await toggleBookmark(resolved);
    setIsBookmarked(nowSaved);
    if (nowSaved) {
      hapticSuccess();
    } else {
      hapticLight();
    }
  };

  const handleBack = () => {
    hapticLight();
    onBack();
  };

  // A finished last-watched episode means "up next" is the following one,
  // not a resume into its end credits.
  const historyIndex = history ? episodes.findIndex(e => e.id === history.episodeId) : -1;
  const upNext = history && isEpisodeFinished(history) && historyIndex >= 0
    ? episodes[historyIndex + 1]
    : undefined;

  const handlePlay = () => {
    if (!resolved) return;
    if (!playAnime) return;
    hapticMedium();
    const historyMode = dubAvailable === false ? 'sub' : history?.mode;
    if (upNext) {
      onPlayEpisode(playAnime, upNext, historyMode || playMode);
    } else if (history) {
      const item = { ...history, mode: historyMode || history.mode };
      onResume(playAnime, isEpisodeFinished(item) ? { ...item, currentTime: 0 } : item);
    } else if (episodes.length > 0) {
      onPlayEpisode(playAnime, episodes[0], playMode);
    }
  };

  const playLabel = upNext
    ? `Play E${upNext.number}`
    : history
      ? (isEpisodeFinished(history) ? `Rewatch E${history.episodeNumber}` : `Resume E${history.episodeNumber}`)
      : episodes.length > 0 ? `Play E${episodes[0].number}` : 'Play';

  // Pagination for large episode lists (50 per range)
  const chunkSize = 50;
  const rangeCount = Math.max(1, Math.ceil(episodes.length / chunkSize));

  // Long series: until the user picks a range, show the one holding the
  // episode they're on instead of always 1-50.
  const upNextIndex = upNext ? historyIndex + 1 : historyIndex;
  const autoRange = upNextIndex >= 0 ? Math.floor(upNextIndex / chunkSize) : 0;
  const activeRange = pickedRange ?? autoRange;
  const currentChunk = episodes.slice(activeRange * chunkSize, (activeRange + 1) * chunkSize);

  const description = shown.description || details?.description;
  const genres = (details?.genres.length ? details.genres : shown.genres) || [];
  const collection = details?.collection || [];
  const suggestions = details?.suggestions || [];

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'episodes', label: 'Episodes' },
    ...(collection.length > 0 ? [{ id: 'collection' as DetailTab, label: 'Collection' }] : []),
    { id: 'similar', label: 'More Like This' }
  ];

  const metaParts = [
    shown.type || 'TV',
    episodes.length > 0 ? `${episodes.length} Episode${episodes.length === 1 ? '' : 's'}` : null,
    dubAvailable === false ? 'Sub' : shown.dubCount || dubAvailable ? 'Sub | Dub' : 'Sub'
  ].filter(Boolean);

  return (
    <div className="screen-scroll" style={{ paddingBottom: '40px', position: 'relative' }}>
      {/* Backdrop */}
      <div style={{ position: 'relative', width: '100%', height: '280px' }}>
        <FadeImage
          src={shown.banner || shown.poster}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(8,9,14,0.55) 0%, rgba(8,9,14,0.82) 70%, var(--bg-main) 100%)'
        }} />
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
            onClick={handleBack}
            className="interactive glass-pill-dark"
            aria-label="Back"
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-pill)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(0,0,0,0.45)'
            }}
          >
            <ArrowLeft size={20} />
          </button>

          {resolved && (
            <button
              onClick={handleBookmarkToggle}
              className="interactive glass-pill-dark"
              aria-label={isBookmarked ? "In Watchlist" : "Add to Watchlist"}
              style={{
                width: '42px',
                height: '42px',
                borderRadius: 'var(--radius-pill)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: isBookmarked ? '0 4px 16px rgba(229, 9, 20, 0.45)' : '0 4px 14px rgba(0,0,0,0.45)',
                background: isBookmarked ? 'linear-gradient(135deg, #ff3b45 0%, #e50914 100%)' : undefined,
                color: isBookmarked ? '#ffffff' : 'var(--text-primary)'
              }}
            >
              <Bookmark size={20} fill={isBookmarked ? "#ffffff" : "none"} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: '0 20px', marginTop: '-74px', position: 'relative', zIndex: 10 }}>
        {/* Poster + title */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', marginBottom: '16px' }}>
          <div id="detail-poster-target" style={{ flexShrink: 0 }}>
            <FadeImage
              src={shown.poster}
              alt={shown.title}
              style={{
                width: '108px',
                height: '154px',
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--card-shadow-hover)',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                display: 'block'
              }}
            />
          </div>
          <div style={{ flex: 1, paddingBottom: '4px', minWidth: 0 }}>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: '1.25', letterSpacing: '-0.3px' }}>
              {shown.title}
            </h1>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', fontWeight: 600 }}>
              {metaParts.join('  •  ')}
            </div>
          </div>
        </div>

        {resolveError ? (
          <div className="glass-panel" style={{ padding: '16px', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '18px' }}>
            {resolveError}
          </div>
        ) : (
          <>
            {/* Play / Resume - Apple style white pill button */}
            <button
              onClick={handlePlay}
              disabled={!resolved || (episodes.length === 0 && !history)}
              className="interactive"
              style={{
                width: '100%',
                padding: '13px',
                borderRadius: 'var(--radius-md)',
                background: '#ffffff',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                color: '#000000',
                fontSize: '15px',
                fontWeight: 800,
                marginBottom: '12px',
                boxShadow: '0 8px 24px rgba(255, 255, 255, 0.18)',
                opacity: !resolved || (episodes.length === 0 && !history) ? 0.6 : 1
              }}
            >
              {loading && !history ? <Loader2 size={20} className="animate-spin" /> : <Play size={20} fill="#000" />}
              <span>{playLabel}</span>
            </button>

            {history && history.duration > 0 && !upNext && !isEpisodeFinished(history) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <div style={{ flex: 1, height: '3px', backgroundColor: 'rgba(127,127,127,0.35)', borderRadius: '2px' }}>
                  <div style={{
                    width: `${Math.min(100, (history.currentTime / history.duration) * 100)}%`,
                    height: '100%',
                    backgroundColor: '#e50914',
                    borderRadius: '2px'
                  }} />
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {Math.max(0, Math.round((history.duration - history.currentTime) / 60))}m remaining
                </span>
              </div>
            )}
          </>
        )}

        {/* Synopsis */}
        {description && (
          <p
            onClick={() => { hapticLight(); setExpanded(e => !e); }}
            style={{
              fontSize: '13px',
              color: 'var(--text-primary)',
              opacity: 0.85,
              lineHeight: '1.5',
              marginBottom: '8px',
              display: expanded ? 'block' : '-webkit-box',
              WebkitLineClamp: expanded ? undefined : 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {description}
          </p>
        )}
        {genres.length > 0 && (
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
            <span style={{ fontWeight: 700 }}>Genres: </span>{genres.join(', ')}
          </p>
        )}


        {/* Tabs - Apple segmented pill control */}
        <div className="seg-track" style={{ marginBottom: '18px' }}>
          {tabs.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => { hapticLight(); setTab(t.id); }}
                className={`interactive seg-pill ${active ? 'active' : ''}`}
                style={{ padding: '8px 14px', fontSize: '13px' }}
              >
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {!settled && (
          <div className="grid-episodes">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: '62px', borderRadius: 'var(--radius-sm)' }} />
            ))}
          </div>
        )}

        {settled && tab === 'episodes' && (
          <>
            {rangeCount > 1 && (
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '12px', marginBottom: '6px' }}>
                {Array.from({ length: rangeCount }).map((_, i) => {
                  const start = i * chunkSize + 1;
                  const end = Math.min(episodes.length, (i + 1) * chunkSize);
                  return (
                    <button
                      key={i}
                      onClick={() => { hapticSelection(); setActiveRange(i); }}
                      className={`interactive glass-pill chip ${activeRange === i ? 'active' : ''}`}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '4px',
                        color: activeRange === i ? undefined : 'var(--text-secondary)',
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

            {episodesError && !loading ? (
              <ErrorState compact message="Couldn't load the episode list." onRetry={retryEpisodes} />
            ) : loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: '10px', color: 'var(--text-secondary)' }}>
                <Loader2 size={24} className="animate-spin" />
                <span style={{ fontSize: '14px' }}>Fetching episodes...</span>
              </div>
            ) : (
              <div className="grid-episodes">
                {currentChunk.map((ep) => {
                  const isLastWatched = history?.episodeId === ep.id;
                  const entry = progress[ep.id];
                  const watchState = episodeWatchState(entry);
                  const pct = entry && entry.duration > 0
                    ? Math.min(100, Math.round((entry.currentTime / entry.duration) * 100))
                    : 0;
                  const dl = downloads.find(d => d.id === downloadId(shown.id, ep.id, playMode));
                  return (
                    <div key={ep.id} style={{ position: 'relative', display: 'flex' }}>
                    <button
                      onClick={() => {
                        if (!playAnime) return;
                        hapticMedium();
                        // Half-watched: continue where it was left.
                        if (entry && watchState === 'partial') {
                          onResume(playAnime, {
                            animeId: playAnime.id,
                            animeTitle: playAnime.title,
                            poster: playAnime.poster,
                            episodeId: ep.id,
                            episodeNumber: ep.number,
                            currentTime: entry.currentTime,
                            duration: entry.duration,
                            updatedAt: Date.now(),
                            mode: playMode
                          });
                        } else {
                          onPlayEpisode(playAnime, ep, playMode);
                        }
                      }}
                      className="interactive card-bouncy glass-panel"
                      style={{
                        flex: 1,
                        padding: '14px 8px',
                        borderRadius: 'var(--radius-sm)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px',
                        overflow: 'hidden',
                        opacity: watchState === 'finished' && !isLastWatched ? 0.62 : 1
                      }}
                      aria-label={`Episode ${ep.number}${watchState === 'finished' ? ', watched' : watchState === 'partial' ? ', in progress' : ''}`}
                    >
                      <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>{ep.number}</span>
                      <span style={{
                        fontSize: '10px',
                        color: watchState === 'finished' ? 'var(--text-muted)' : 'var(--accent-primary)',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '3px'
                      }}>
                        {watchState === 'finished' && <Check size={10} />}
                        {watchState === 'finished' ? 'Watched' : watchState === 'partial' || isLastWatched ? 'Resume' : 'Play'}
                      </span>
                      {watchState === 'partial' && (
                        <span style={{ position: 'absolute', left: 0, bottom: 0, height: '3px', width: `${pct}%`, background: '#e50914' }} />
                      )}
                    </button>
                    {canDownload && playAnime && (
                      <DownloadButton
                        record={dl}
                        onStart={() => { hapticSelection(); startDownload(playAnime, ep, playMode).catch(err => console.warn('[downloads] start failed:', err)); }}
                        onRemove={() => { hapticLight(); void removeDownload(downloadId(shown.id, ep.id, playMode)); }}
                      />
                    )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {settled && tab === 'collection' && (
          <div className="grid-collection">
            {collection.map(item => {
              const isCurrent = item.id === shown.id;
              return (
                <PosterCard
                  key={item.id}
                  anime={item}
                  caption={item.seasonLabel || item.title}
                  highlighted={isCurrent}
                  badge={isCurrent ? 'Now Viewing' : undefined}
                  onSelect={isCurrent ? undefined : onSelectAnime}
                />
              );
            })}
          </div>
        )}

        {settled && tab === 'similar' && (
          details === null ? (
            <div className="grid-collection">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ borderRadius: '4px', paddingTop: '145%' }} />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <p style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
              No suggestions found for this title.
            </p>
          ) : (
            <div className="grid-collection">
              {suggestions.map(item => (
                <PosterCard key={item.id} anime={item} onSelect={onSelectAnime} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};
