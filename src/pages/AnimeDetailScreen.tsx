import React, { useState, useEffect } from 'react';
import { ArrowLeft, Play, Bookmark, Check, Loader2, ChevronDown } from 'lucide-react';
import { CategoryPicker, type CategorySection } from 'streamkit/ui/CategoryPicker.tsx';
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
import { getEpisodeInfo, getEpisodeSynopsis, type EpisodeInfo } from '../providers/episodeInfoService';
import { getStoryArcs, type StoryArc } from '../providers/arcService';
import { LONG_RUNNING_EPISODES } from '../providers/seasonService';
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
  // Replaces this page with another season of the same show.
  onSwitchSeason: (anime: AnimeItem) => void;
}

type DetailTab = 'episodes' | 'collection' | 'similar';

export const AnimeDetailScreen: React.FC<AnimeDetailScreenProps> = ({
  anime,
  onBack,
  onPlayEpisode,
  onResume,
  onSelectAnime,
  onSwitchSeason
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
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [seasonPickerOpen, setSeasonPickerOpen] = useState<boolean>(false);
  // Synopses fetched on demand for an opened episode (MyAnimeList), by episode number.
  const [extraSynopsis, setExtraSynopsis] = useState<Record<string, string>>({});
  // The one episode tile whose full description is open (accordion).
  const [expandedEp, setExpandedEp] = useState<string | null>(null);
  const [arcs, setArcs] = useState<StoryArc[]>([]);
  // Per-episode thumbnails/synopses (Kitsu), filled in for the visible range.
  const [epInfo, setEpInfo] = useState<Record<string, EpisodeInfo>>({});
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

  // Story arcs (when TMDB has them for this show) replace the blocks of 50 in the picker.
  useEffect(() => {
    if (!resolved || episodes.length < 2) { setArcs([]); return; }
    let cancelled = false;
    getStoryArcs(resolved, episodes.length).then(found => {
      if (cancelled) return;
      setArcs(found);
      setActiveRange(null); // range indexes changed meaning: follow the episode the viewer is on
    });
    return () => { cancelled = true; };
  }, [resolved, episodes.length]);

  // One picker, never two: a show split into short TV seasons gets the season switcher (seasonService);
  // a long-running one gets its story arcs (arcService) or, without arcs, blocks of 50 episodes.
  // Movies have no episode list at all.
  const isMovie = /^movie$/i.test(shown.type || '');
  const seasons = details?.seasons ?? [];
  const seasonMode = seasons.length > 1 && !isMovie && episodes.length < LONG_RUNNING_EPISODES;
  const chunkSize = 50;
  const rangeLabel = (i: number) => {
    const start = i * chunkSize + 1;
    const end = Math.min(episodes.length, (i + 1) * chunkSize);
    return start === end ? `Episode ${start}` : `Episodes ${start}\u2013${end}`;
  };
  const arcMode = !seasonMode && arcs.length > 1;
  const ranges = seasonMode
    ? [{ name: 'All episodes', start: 0, end: episodes.length }]
    : arcMode
    ? arcs.map(a => ({ name: `${a.name} \u00b7 ${a.start === a.end ? a.start : `${a.start}\u2013${a.end}`}`, start: a.start - 1, end: a.end }))
    : Array.from({ length: Math.max(1, Math.ceil(episodes.length / chunkSize)) }, (_, i) => ({
        name: rangeLabel(i), start: i * chunkSize, end: Math.min(episodes.length, (i + 1) * chunkSize)
      }));
  const rangeCount = ranges.length;

  // Long series: until the user picks a range, show the one holding the
  // episode they're on instead of always the first.
  const upNextIndex = upNext ? historyIndex + 1 : historyIndex;
  const autoRange = upNextIndex >= 0 ? Math.max(0, ranges.findIndex(r => upNextIndex >= r.start && upNextIndex < r.end)) : 0;
  const activeRange = Math.min(pickedRange ?? autoRange, rangeCount - 1);
  const listEpisodes = episodes.slice(ranges[activeRange]?.start ?? 0, ranges[activeRange]?.end ?? chunkSize);
  const chunkKey = listEpisodes.map(e => e.number).join(',');
  useEffect(() => {
    if (!resolved || !chunkKey) return;
    let cancelled = false;
    getEpisodeInfo(resolved, chunkKey.split(','), episodes.length).then(info => {
      if (!cancelled && Object.keys(info).length > 0) setEpInfo(prev => ({ ...prev, ...info }));
    });
    return () => { cancelled = true; };
    // `episodes.length` only guards the match; the visible range drives loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, chunkKey]);


  const description = shown.description || details?.description;
  const genres = (details?.genres.length ? details.genres : shown.genres) || [];

  const pickerSections: CategorySection[] = [{ items: ranges.map((r, i) => ({ key: `r:${i}`, name: r.name })) }];
  const pickerSelected = `r:${activeRange}`;
  const pickerLabel = ranges[activeRange]?.name ?? '';
  const suggestions = details?.suggestions || [];

  // A movie has one "episode": no Episodes tab, just Play and the rest.
  const currentSeason = seasons.find(x => x.id === shown.id);
  // The rest of the franchise (movies, OVAs, specials, spin-offs); catalogService already leaves
  // out this title and its seasons, which are in the season picker.
  const collection = (details?.collection || []).filter(c => c.id !== shown.id);
  const seasonSections: CategorySection[] = [{ items: seasons.map(x => ({ key: x.id, name: x.seasonLabel || x.title })) }];
  const tabs: { id: DetailTab; label: string }[] = [
    ...(isMovie ? [] : [{ id: 'episodes' as DetailTab, label: 'Episodes' }]),
    ...(collection.length > 0 ? [{ id: 'collection' as DetailTab, label: 'Collection' }] : []),
    { id: 'similar', label: 'More Like This' }
  ];

  const activeTab: DetailTab = isMovie && tab === 'episodes' ? (collection.length > 0 ? 'collection' : 'similar') : tab;

  // Opening an episode whose synopsis Kitsu lacks asks MyAnimeList for it.
  const openEpisode = (ep: { id: string; number: string }, willOpen: boolean) => {
    setExpandedEp(willOpen ? ep.id : null);
    if (willOpen && resolved && !epInfo[ep.number]?.synopsis && extraSynopsis[ep.number] === undefined) {
      getEpisodeSynopsis(resolved, ep.number, episodes.length).then(text => {
        if (text) setExtraSynopsis(prev => ({ ...prev, [ep.number]: text }));
      });
    }
  };

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
                boxShadow: isBookmarked ? '0 4px 16px var(--accent-shadow)' : '0 4px 14px rgba(0,0,0,0.45)',
                background: isBookmarked ? 'var(--accent-gradient)' : undefined,
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
                    backgroundColor: 'var(--accent-primary)',
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
            const active = activeTab === t.id;
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

        {settled && activeTab === 'episodes' && (
          <>
            {seasonMode && (
              <button
                onClick={() => { hapticLight(); setSeasonPickerOpen(true); }}
                className="interactive"
                aria-haspopup="dialog"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '12px', padding: '10px 14px',
                  marginRight: '10px', marginBottom: '14px', background: 'var(--track-bg)',
                  border: '1px solid var(--border-subtle)', borderRadius: '4px',
                  color: 'var(--text-primary)', fontSize: '15px', fontWeight: 700
                }}
              >
                <span>{currentSeason?.seasonLabel || 'Seasons'}</span>
                <ChevronDown size={18} />
              </button>
            )}
            <CategoryPicker
              open={seasonPickerOpen}
              presentation="card"
              title="Seasons"
              sections={seasonSections}
              selectedKey={currentSeason?.id ?? ''}
              onSelect={key => {
                hapticSelection();
                setSeasonPickerOpen(false);
                const next = seasons.find(x => x.id === key);
                // Switching season replaces this page (it is the same show), never stacks another.
                if (next && next.id !== shown.id && next.id !== anime.id) onSwitchSeason(next);
              }}
              onClose={() => { hapticLight(); setSeasonPickerOpen(false); }}
            />
            {rangeCount > 1 && (
              <button
                onClick={() => { hapticLight(); setPickerOpen(true); }}
                className="interactive"
                aria-haspopup="dialog"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 14px',
                  marginBottom: '14px',
                  background: 'var(--track-bg)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                  fontSize: '15px',
                  fontWeight: 700
                }}
              >
                <span>{pickerLabel}</span>
                <ChevronDown size={18} />
              </button>
            )}

            <CategoryPicker
              open={pickerOpen}
              presentation="card"
              title={arcMode ? 'Story arcs' : 'Episodes'}
              sections={pickerSections}
              selectedKey={pickerSelected}
              onSelect={key => {
                hapticSelection();
                setPickerOpen(false);
                if (key.startsWith('r:')) setActiveRange(Number(key.slice(2)));
              }}
              onClose={() => { hapticLight(); setPickerOpen(false); }}
            />

            {episodesError && !loading ? (
              <ErrorState compact message="Couldn't load the episode list." onRetry={retryEpisodes} />
            ) : loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: '10px', color: 'var(--text-secondary)' }}>
                <Loader2 size={24} className="animate-spin" />
                <span style={{ fontSize: '14px' }}>Fetching episodes...</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {listEpisodes.map((ep) => {
                  const isLastWatched = history?.episodeId === ep.id;
                  const entry = progress[ep.id];
                  const watchState = episodeWatchState(entry);
                  const pct = entry && entry.duration > 0
                    ? Math.min(100, Math.round((entry.currentTime / entry.duration) * 100))
                    : 0;
                  const dl = downloads.find(d => d.id === downloadId(shown.id, ep.id, playMode));
                  const info = epInfo[ep.number];
                  const siteTitle = !ep.title || ep.title.trim().toLowerCase() === `episode ${ep.number}` ? undefined : ep.title;
                  const epTitle = siteTitle || info?.title;
                  const status = watchState === 'finished' ? 'Watched'
                    : watchState === 'partial' ? `${pct}% watched`
                    : isLastWatched ? 'Last watched' : null;
                  const play = () => {
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
                  };
                  const expanded = expandedEp === ep.id;
                  return (
                    <div
                      key={ep.id}
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      // Tapping the tile opens (or closes) its description; opening
                      // another one closes this one. Only the thumbnail plays.
                      onClick={() => { hapticSelection(); openEpisode(ep, !expanded); }}
                      onKeyDown={e => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          openEpisode(ep, !expanded);
                        }
                      }}
                      className="interactive glass-panel"
                      aria-label={`Episode ${ep.number}${status ? `, ${status}` : ''}`}
                      style={{
                        borderRadius: 'var(--radius-md)',
                        overflow: 'hidden',
                        display: 'flex',
                        gap: '14px',
                        padding: '12px',
                        alignItems: expanded ? 'flex-start' : 'center',
                        opacity: watchState === 'finished' && !isLastWatched ? 0.7 : 1
                      }}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Play episode ${ep.number}`}
                        onClick={e => { e.stopPropagation(); play(); }}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); play(); } }}
                        style={{ position: 'relative', width: '124px', height: '70px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0, background: 'var(--track-bg)', cursor: 'pointer' }}>
                        <FadeImage src={info?.thumbnail || shown.banner || shown.poster} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ width: '30px', height: '30px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Play size={14} fill="#fff" color="#fff" style={{ marginLeft: '1px' }} />
                          </div>
                        </div>
                        {watchState === 'partial' && (
                          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px', backgroundColor: 'rgba(255,255,255,0.2)' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent-primary)' }} />
                          </div>
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 style={{
                          fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px',
                          ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' })
                        }}>
                          {ep.number}. {epTitle || `Episode ${ep.number}`}
                        </h3>
                        {status && (
                          <p style={{ fontSize: '12px', color: watchState === 'finished' ? 'var(--text-muted)' : 'var(--accent-primary)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600 }}>
                            {watchState === 'finished' && <Check size={12} />}
                            {status}
                          </p>
                        )}
                        {(info?.synopsis || extraSynopsis[ep.number] || expanded) && (
                          <p style={{
                            fontSize: '12px', lineHeight: 1.45, color: 'var(--text-secondary)', marginTop: '4px',
                            ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' })
                          }}>
                            {info?.synopsis || extraSynopsis[ep.number] || 'No description available for this episode.'}
                          </p>
                        )}
                      </div>

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

        {settled && activeTab === 'collection' && (
          <div className="grid-collection">
            {collection.map(item => (
              <PosterCard key={item.id} anime={item} caption={item.title} onSelect={onSelectAnime} />
            ))}
          </div>
        )}

        {settled && activeTab === 'similar' && (
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
