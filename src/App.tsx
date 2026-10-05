// App.tsx - Main Android Application Controller for AniStream
import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Home as HomeIcon, Search as SearchIcon, Library, Settings as SettingsIcon } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ExoPlayerPlugin } from './plugins/exoPlayerPlugin';
import { HomeScreen } from './pages/HomeScreen';
import { SearchScreen } from './pages/SearchScreen';
import { AnimeDetailScreen } from './pages/AnimeDetailScreen';
import { HistoryScreen } from './pages/HistoryScreen';
import { GenreScreen } from './pages/GenreScreen';
import type { Genre } from './services/catalogService';
import { SettingsScreen } from './pages/SettingsScreen';
import { ConfirmModal } from './components/ConfirmModal';
import {
  getEpisodeStream,
  getEpisodes,
  prefetchEpisodeStream,
  SourceUnavailableError,
  type AnimeItem,
  type EpisodeItem,
  type StreamSource
} from './core/aniCliCore';
import { saveWatchProgress, getUserPreferences, type WatchHistoryItem } from './services/historyService';
import { getTheme, getStoredThemeSync, setTheme as persistTheme, type ThemeMode } from './services/themeService';

// The web player (and hls.js, most of the bundle's weight) is only needed
// once something plays - and never on Android, where ExoPlayer plays - so
// it's split out of the startup bundle.
const VideoPlayer = lazy(() => import('./components/VideoPlayer').then(m => ({ default: m.VideoPlayer })));

// Start resolving the next episode once this much of the current one has
// played, so "Next Episode" starts without a wait.
const PREFETCH_NEXT_AT = 0.8;

type Tab = 'home' | 'search' | 'library' | 'settings';

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<Tab>('home');
  // Title pages stack up (opening a suggestion from a title page and backing
  // out returns to the previous title, like Netflix); a genre page sits
  // underneath them.
  const [animeStack, setAnimeStack] = useState<AnimeItem[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const selectedAnime = animeStack.length > 0 ? animeStack[animeStack.length - 1] : null;
  const pushAnime = (anime: AnimeItem) => setAnimeStack(stack => [...stack, anime]);
  const popAnime = () => setAnimeStack(stack => stack.slice(0, -1));
  const openGenre = (genre: Genre) => {
    setAnimeStack([]);
    setSelectedGenre(genre);
  };
  const switchTab = (tab: Tab) => {
    setAnimeStack([]);
    setSelectedGenre(null);
    setCurrentTab(tab);
  };
  const [theme, setThemeState] = useState<ThemeMode>(getStoredThemeSync());

  // Apply the theme to <html> (index.html already set an initial value
  // synchronously pre-paint) and reconcile it with the persisted preference,
  // which may live in native storage and not match the localStorage guess.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f1f2f6' : '#0d0f17');
  }, [theme]);

  useEffect(() => {
    getTheme().then(setThemeState);
  }, []);

  const handleSetTheme = (next: ThemeMode) => {
    setThemeState(next);
    persistTheme(next);
  };

  // Active player state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playingAnime, setPlayingAnime] = useState<AnimeItem | null>(null);
  const [playingEpisode, setPlayingEpisode] = useState<EpisodeItem | null>(null);
  const [playingMode, setPlayingMode] = useState<'sub' | 'dub'>('sub');
  const [streamSource, setStreamSource] = useState<StreamSource | null>(null);
  const [streamLoading, setStreamLoading] = useState<boolean>(false);
  const [initialSeekTime, setInitialSeekTime] = useState<number>(0);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);
  // Bumped on every play request and whenever the native player is closed,
  // so a slow stream resolution that finishes after the user moved on (or
  // backed out of the player) is dropped instead of reopening the player.
  const playRequestRef = useRef<number>(0);

  // The real episode list for whichever anime is currently playing - used to
  // find the actual next episode (real id/title) instead of guessing one,
  // and to know for certain whether a next episode even exists.
  const [episodeList, setEpisodeList] = useState<EpisodeItem[]>([]);
  const loadedEpisodeListAnimeId = useRef<string | null>(null);

  // Kept in refs so the native mode-switch listener (subscribed once) always
  // sees the currently playing anime/episode without re-subscribing.
  const playingAnimeRef = useRef<AnimeItem | null>(null);
  const playingEpisodeRef = useRef<EpisodeItem | null>(null);
  const playingModeRef = useRef<'sub' | 'dub'>('sub');
  const startTimeRef = useRef<number>(0);
  const episodeListRef = useRef<EpisodeItem[]>([]);
  playingAnimeRef.current = playingAnime;
  playingEpisodeRef.current = playingEpisode;
  playingModeRef.current = playingMode;
  episodeListRef.current = episodeList;

  // Real next-episode lookup shared by the manual "Next" button, the native
  // player's next-episode card, and the hasNextEpisode flag - undefined
  // means "we don't actually know of one", which the caller must respect
  // rather than fabricate an episode number/id that may not exist or use
  // the wrong id scheme.
  const findNextEpisode = (current: EpisodeItem | null, list: EpisodeItem[]): EpisodeItem | undefined => {
    if (!current) return undefined;
    const idx = list.findIndex(e => e.id === current.id);
    if (idx === -1 || idx + 1 >= list.length) return undefined;
    return list[idx + 1];
  };

  // The native ExoPlayer's Sub/Dub button and "Next Episode" card can't
  // re-resolve a stream themselves - they notify us here so we can call
  // getEpisodeStream() again and relaunch the player. Read anime/episode from
  // refs, not state: this effect subscribes once (empty deps), so closing
  // over the state variables directly would only ever see their initial
  // (null) values.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const modeHandle = ExoPlayerPlugin.addListener('modeSwitchRequested', ({ mode }) => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (anime && episode) {
        handlePlayEpisode(anime, episode, mode, 0);
      }
    });
    const nextEpHandle = ExoPlayerPlugin.addListener('nextEpisodeRequested', () => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (!anime || !episode) return;
      const next = findNextEpisode(episode, episodeListRef.current);
      if (!next) return; // no real next episode - never guess one
      handlePlayEpisode(anime, next, playingModeRef.current, 0);
    });
    const episodeSelectedHandle = ExoPlayerPlugin.addListener('episodeSelected', ({ selectedNumber }) => {
      const anime = playingAnimeRef.current;
      if (!anime) return;
      const selected = episodeListRef.current.find(e => e.number === selectedNumber);
      if (!selected) return; // not a real episode from the list - never guess one
      handlePlayEpisode(anime, selected, playingModeRef.current, 0);
    });
    // The player's "Retry" after a failure: the CDN link may simply have
    // expired, so resolve the episode afresh and resume where it stopped.
    const retryHandle = ExoPlayerPlugin.addListener('retryRequested', ({ positionMs }) => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (!anime || !episode) return;
      // No position yet (the stream never started) -> keep the original
      // start point, e.g. a resume from history.
      const resumeAt = positionMs > 0 ? positionMs / 1000 : startTimeRef.current;
      handlePlayEpisode(anime, episode, playingModeRef.current, resumeAt, true);
    });
    // The native player is the only place playback position lives - unlike
    // the web <VideoPlayer>, which reports progress via its own
    // onProgressUpdate prop, native has no such prop path (it isn't even
    // mounted while native plays), so watch history only gets saved if we
    // save it here, from this bridged event.
    const closedHandle = ExoPlayerPlugin.addListener('playerClosed', () => {
      playRequestRef.current++;
      setStreamLoading(false);
    });
    const progressHandle = ExoPlayerPlugin.addListener('progressUpdate', ({ positionMs, durationMs }) => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (!anime || !episode || durationMs <= 0) return;
      maybePrefetchNext(positionMs / 1000, durationMs / 1000);
      saveWatchProgress({
        animeId: anime.id,
        animeTitle: anime.title,
        poster: anime.poster,
        episodeId: episode.id,
        episodeNumber: episode.number,
        currentTime: positionMs / 1000,
        duration: durationMs / 1000,
        updatedAt: Date.now(),
        mode: playingModeRef.current
      });
    });
    return () => {
      modeHandle.then(h => h.remove());
      nextEpHandle.then(h => h.remove());
      episodeSelectedHandle.then(h => h.remove());
      progressHandle.then(h => h.remove());
      retryHandle.then(h => h.remove());
      closedHandle.then(h => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Near the end of an episode, resolve the next one in the background (once
  // per episode) so it's ready the moment it's needed.
  const prefetchedRef = useRef<string | null>(null);
  const maybePrefetchNext = (time: number, duration: number) => {
    if (duration <= 0 || time / duration < PREFETCH_NEXT_AT) return;
    const anime = playingAnimeRef.current;
    const next = findNextEpisode(playingEpisodeRef.current, episodeListRef.current);
    if (!anime || !next) return;
    const key = `${anime.id}:${next.id}:${playingModeRef.current}`;
    if (prefetchedRef.current === key) return;
    prefetchedRef.current = key;
    prefetchEpisodeStream(anime.id || anime.title, next.id || next.number, playingModeRef.current, anime.id);
  };

  // Play an episode. forceRefresh skips any cached stream resolution (used
  // when retrying after a playback failure).
  const handlePlayEpisode = async (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub' = 'sub',
    startTime = 0,
    forceRefresh = false
  ) => {
    const requestId = ++playRequestRef.current;
    const isNative = Capacitor.isNativePlatform();
    setStreamLoading(true);
    // Native: open the player right away in its loading state (title +
    // spinner) instead of a blocking overlay here; the stream is handed to
    // that same player once resolved. For next episode / audio switch the
    // player is already open and simply shows its spinner again.
    if (isNative) {
      ExoPlayerPlugin.open({ title: anime.title, episode: episode.number, mode }).catch(err =>
        console.warn('[App] ExoPlayer open failed:', err));
    }
    setPlayingAnime(anime);
    setPlayingEpisode(episode);
    setPlayingMode(mode);
    setInitialSeekTime(startTime);
    startTimeRef.current = startTime;

    // Real episode list for this anime, used for hasNextEpisode/next-episode
    // lookups and the native player's episode picker - only re-fetched when
    // the anime actually changes (advancing to the next episode of the same
    // anime reuses what's already loaded). Fetched in parallel with the
    // stream itself but awaited before use, so the very first episode
    // played for a given anime doesn't race a stale/empty list into the
    // native "Episodes" button.
    const needsEpisodeList = loadedEpisodeListAnimeId.current !== anime.id;
    // The list only powers next/episode-picker - a failure there must not
    // block playing the episode the user actually asked for.
    const episodeListPromise: Promise<EpisodeItem[] | null> = needsEpisodeList
      ? getEpisodes(anime.id || anime.title).catch(err => {
          console.warn('[App] episode list unavailable, playing without it:', err);
          return null;
        })
      : Promise.resolve(episodeListRef.current);

    try {
      const [source, resolvedEpisodeList] = await Promise.all([
        getEpisodeStream(anime.id || anime.title, episode.id || episode.number, mode, anime.id, forceRefresh),
        episodeListPromise
      ]);

      // The user picked something else meanwhile, or closed the player.
      if (requestId !== playRequestRef.current) return;

      // On failure, keep it marked as not loaded so the next play retries.
      const episodesForPlayer = resolvedEpisodeList ?? [];
      if (needsEpisodeList) {
        setEpisodeList(episodesForPlayer);
        loadedEpisodeListAnimeId.current = resolvedEpisodeList ? anime.id : null;
      }

      // Apply the "Default Quality" preference when the stream actually
      // offers more than one distinct rendition to choose from.
      const prefs = await getUserPreferences();
      const preferred = source.qualities?.find(q => q.quality === prefs.defaultQuality);
      if (preferred && preferred.url !== source.streamUrl) {
        source.streamUrl = preferred.url;
        source.quality = preferred.quality;
      }

      if (requestId !== playRequestRef.current) return;
      setStreamSource(source);

      if (isNative) {
        try {
          console.log("[App] Launching Android Native ExoPlayer...");
          await ExoPlayerPlugin.play({
            url: source.streamUrl,
            title: anime.title,
            episode: episode.number,
            referer: source.referer,
            mode,
            subtitles: source.subtitles,
            qualities: source.qualities,
            episodes: episodesForPlayer.map(e => ({ id: e.id, number: e.number })),
            intro: source.intro,
            outro: source.outro,
            startPositionMs: Math.max(0, Math.round(startTime * 1000))
          });
        } catch (e) {
          console.warn("[App] ExoPlayer plugin call failed, falling back to Web player:", e);
          setIsPlaying(true);
        }
      } else {
        setIsPlaying(true);
      }
    } catch (err) {
      console.error("Failed to load stream:", err);
      if (requestId !== playRequestRef.current) return;
      const message = err instanceof SourceUnavailableError
        ? "This episode isn't available from any server right now. Try again in a bit, or switch Sub/Dub."
        : "Couldn't load this episode - check your connection and try again.";
      if (isNative) {
        ExoPlayerPlugin.fail({ message }).catch(() => setStreamErrorMessage(message));
      } else {
        setStreamErrorMessage(message);
      }
    } finally {
      if (requestId === playRequestRef.current) setStreamLoading(false);
    }
  };

  // Resume from continue watching
  const handleResumeEpisode = (historyItem: WatchHistoryItem) => {
    const matchedAnime: AnimeItem = {
      id: historyItem.animeId,
      title: historyItem.animeTitle,
      poster: historyItem.poster,
      type: 'TV'
    };

    const resumeEpisode: EpisodeItem = {
      id: historyItem.episodeId,
      number: historyItem.episodeNumber,
      title: `Episode ${historyItem.episodeNumber}`
    };

    handlePlayEpisode(matchedAnime, resumeEpisode, historyItem.mode, historyItem.currentTime);
  };

  // Next episode handler (manual "Next" tap) - always honored regardless of
  // the autoplay preference, which only governs auto-advance on onEnded.
  const handleNextEpisode = () => {
    if (!playingEpisode || !playingAnime) return;
    const next = findNextEpisode(playingEpisode, episodeList);
    if (!next) return;
    handlePlayEpisode(playingAnime, next, playingMode, 0);
  };

  const hasNextEpisode = findNextEpisode(playingEpisode, episodeList) !== undefined;

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: 'var(--bg-main)',
      overflow: 'hidden',
      position: 'relative'
    }}>
      {/* Active Screen Rendering - keyed + animated so switching screens doesn't
          hard-cut: pushing into detail glides in from the right (like iOS
          navigation), switching tabs fades/pops in place. */}
      <div
        key={selectedAnime ? `detail-${animeStack.length}-${selectedAnime.id}` : selectedGenre ? `genre-${selectedGenre.slug}` : currentTab}
        className={selectedAnime || selectedGenre ? 'animate-slide-in' : 'animate-fade-in'}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {selectedAnime ? (
          <AnimeDetailScreen
            anime={selectedAnime}
            onBack={popAnime}
            onPlayEpisode={(anime, ep, mode) => handlePlayEpisode(anime, ep, mode)}
            onResume={(anime, item) => handlePlayEpisode(
              anime,
              { id: item.episodeId, number: item.episodeNumber, title: `Episode ${item.episodeNumber}` },
              item.mode,
              item.currentTime
            )}
            onSelectAnime={pushAnime}
          />
        ) : selectedGenre ? (
          <GenreScreen
            genre={selectedGenre}
            onBack={() => setSelectedGenre(null)}
            onSelectGenre={openGenre}
            onSelectAnime={pushAnime}
          />
        ) : currentTab === 'home' ? (
          <HomeScreen
            onSelectAnime={pushAnime}
            onResumeEpisode={handleResumeEpisode}
            onOpenSearch={() => switchTab('search')}
            onSelectGenre={openGenre}
          />
        ) : currentTab === 'search' ? (
          <SearchScreen
            onBack={() => switchTab('home')}
            onSelectAnime={pushAnime}
            onSelectGenre={openGenre}
          />
        ) : currentTab === 'library' ? (
          <HistoryScreen
            onResumeEpisode={handleResumeEpisode}
            onSelectAnime={pushAnime}
          />
        ) : (
          <SettingsScreen theme={theme} onChangeTheme={handleSetTheme} />
        )}
      </div>

      {/* Stream loading: a slim, non-blocking bar at the top (the native
          player shows its own spinner, so this only matters on web). */}
      {streamLoading && !Capacitor.isNativePlatform() && (
        <div className="stream-loading-bar" role="progressbar" aria-label="Loading episode" />
      )}

      <ConfirmModal
        open={streamErrorMessage !== null}
        title="Playback Failed"
        message={streamErrorMessage || ''}
        confirmLabel="OK"
        onConfirm={() => setStreamErrorMessage(null)}
        onCancel={() => setStreamErrorMessage(null)}
      />

      {/* Fullscreen Cinema Player */}
      {isPlaying && streamSource && playingAnime && playingEpisode && (
        <Suspense fallback={<div className="stream-loading-bar" role="progressbar" aria-label="Loading player" />}>
        <VideoPlayer
          streamSource={streamSource}
          animeTitle={playingAnime.title}
          episode={playingEpisode}
          mode={playingMode}
          initialTime={initialSeekTime}
          onBack={() => setIsPlaying(false)}
          onNextEpisode={handleNextEpisode}
          hasNextEpisode={hasNextEpisode}
          episodeList={episodeList}
          onSelectEpisode={(ep) => handlePlayEpisode(playingAnime, ep, playingMode, 0)}
          onSwitchMode={(newMode) => handlePlayEpisode(playingAnime, playingEpisode, newMode, 0)}
          onProgressUpdate={(time, dur) => {
            maybePrefetchNext(time, dur);
            saveWatchProgress({
              animeId: playingAnime.id,
              animeTitle: playingAnime.title,
              poster: playingAnime.poster,
              episodeId: playingEpisode.id,
              episodeNumber: playingEpisode.number,
              currentTime: time,
              duration: dur,
              updatedAt: Date.now(),
              mode: playingMode
            });
          }}
        />
        </Suspense>
      )}

      {/* Floating Apple-TV style glass dock (hidden during player and detail view).
          Detached from the screen edge with a sliding liquid-glass indicator
          that glides behind whichever tab is active. */}
      {!selectedAnime && !isPlaying && (
        <div
          style={{
            position: 'fixed',
            left: '20px',
            right: '20px',
            bottom: 'calc(16px + var(--safe-bottom))',
            zIndex: 50,
            display: 'flex',
            justifyContent: 'center'
          }}
        >
          <div
            className="glass-dock"
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: '360px',
              height: '64px',
              display: 'flex',
              alignItems: 'stretch'
            }}
          >
            {/* Sliding liquid indicator */}
            <div
              className="dock-indicator"
              style={{
                left: 0,
                width: `${100 / TABS.length}%`,
                transform: `translateX(${TABS.findIndex(t => t.id === currentTab) * 100}%)`
              }}
            />

            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = currentTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  className={`interactive dock-item ${active ? 'active' : ''}`}
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    flex: 1,
                    background: 'none',
                    border: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '3px',
                    color: active ? 'var(--select-text)' : 'var(--text-muted)'
                  }}
                >
                  <Icon size={20} />
                  <span style={{ fontSize: '10px', fontWeight: active ? 700 : 500 }}>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
