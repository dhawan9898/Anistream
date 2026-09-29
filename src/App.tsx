// App.tsx - Main Android Application Controller for AniStream
import React, { useState, useEffect, useRef, useMemo, Suspense, lazy } from 'react';
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
  type AnimeItem,
  type EpisodeItem,
  type StreamSource,
  FEATURED_ANIME
} from './core/aniCliCore';
import { saveWatchProgress, getUserPreferences, isEpisodeFinished, type WatchHistoryItem } from './services/historyService';
import { getTheme, getStoredThemeSync, setTheme as persistTheme, type ThemeMode } from './services/themeService';

// The web player (and hls.js, the largest dependency) is only needed once
// something actually plays in the browser - on Android the native
// ExoPlayer is used - so it's split out of the startup bundle.
const VideoPlayer = lazy(() => import('./components/VideoPlayer').then(m => ({ default: m.VideoPlayer })));

type Tab = 'home' | 'search' | 'library' | 'settings';

interface PlaybackSession {
  anime: AnimeItem;
  episode: EpisodeItem;
  mode: 'sub' | 'dub';
  source: StreamSource;
  startTime: number;
  // Stream URLs of this episode that already failed in the player, so a
  // server fallback never hands one of them back.
  failedUrls: string[];
}

// Persists a position report for a committed session. The demo fallback
// clip is never the real episode, so its "progress" must not overwrite the
// user's real resume point.
function saveSessionProgress(session: PlaybackSession, currentTime: number, duration: number) {
  if (session.source.isFallback || !(duration > 0)) return;
  saveWatchProgress({
    animeId: session.anime.id,
    animeTitle: session.anime.title,
    poster: session.anime.poster,
    episodeId: session.episode.id,
    episodeNumber: session.episode.number,
    currentTime,
    duration,
    updatedAt: Date.now(),
    mode: session.mode
  });
}

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
  const [streamLoading, setStreamLoading] = useState<boolean>(false);
  // What the player is *actually* playing. playingAnime/Episode/Mode above
  // flip as soon as a new episode is requested (so next/prev taps chain
  // correctly), but the old stream keeps playing until the new one
  // resolves - progress must be saved against this committed session, or
  // the old episode's position ends up recorded under the new episode.
  const [nowPlaying, setNowPlaying] = useState<PlaybackSession | null>(null);
  const nowPlayingRef = useRef<PlaybackSession | null>(null);
  nowPlayingRef.current = nowPlaying;
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
    // The native player is the only place playback position lives - unlike
    // the web <VideoPlayer>, which reports progress via its own
    // onProgressUpdate prop, native has no such prop path (it isn't even
    // mounted while native plays), so watch history only gets saved if we
    // save it here, from this bridged event.
    const closedHandle = ExoPlayerPlugin.addListener('playerClosed', () => {
      playRequestRef.current++;
      setStreamLoading(false);
    });
    const streamFailedHandle = ExoPlayerPlugin.addListener('streamFailed', async ({ episode, mode, url, positionMs, message }) => {
      const session = nowPlayingRef.current;
      // Only for the episode this session is playing - a late event from an
      // earlier episode must not trigger a fallback for the current one.
      // (Matched by episode/mode, like progress reports: after a quality
      // switch the player's URL is no longer the session's stream URL.)
      if (!session || episode !== session.episode.number || (mode && mode !== session.mode)) return;
      console.warn('[App] native stream failed:', url, message);
      const recovered = await recoverRef.current(session, positionMs / 1000);
      if (!recovered) {
        ExoPlayerPlugin.fail({ message: `${message}\nNo other server for this episode worked.`, retry: true })
          .catch(() => undefined);
      }
    });
    const progressHandle = ExoPlayerPlugin.addListener('progressUpdate', ({ episode, mode, positionMs, durationMs }) => {
      // The native player sends its final report for episode N *after* it
      // asked for N+1, so match the report to the session it describes
      // rather than to whatever was requested last.
      const session = nowPlayingRef.current;
      if (!session || durationMs <= 0) return;
      if (episode !== session.episode.number || (mode && mode !== session.mode)) return;
      saveSessionProgress(session, positionMs / 1000, durationMs / 1000);
    });
    return () => {
      modeHandle.then(h => h.remove());
      nextEpHandle.then(h => h.remove());
      episodeSelectedHandle.then(h => h.remove());
      progressHandle.then(h => h.remove());
      closedHandle.then(h => h.remove());
      streamFailedHandle.then(h => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playNative = (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub',
    source: StreamSource,
    episodes: EpisodeItem[],
    startTime: number
  ) => ExoPlayerPlugin.play({
    url: source.streamUrl,
    title: anime.title,
    episode: episode.number,
    referer: source.referer,
    mode,
    subtitles: source.subtitles,
    qualities: source.qualities,
    episodes: episodes.map(e => ({ id: e.id, number: e.number })),
    isFallback: source.isFallback,
    intro: source.intro,
    outro: source.outro,
    startPositionMs: Math.max(0, Math.round(startTime * 1000))
  });

  // The playing stream died in a way retrying it can't fix (e.g. the CDN
  // answered 404 for its playlist or a segment - one episode's files gone
  // from one server while the next episode plays fine). Find another server
  // for the same episode, skipping every stream that already failed, and
  // continue at the same position. Resolves false when none is left (the
  // caller then shows its own error with Retry).
  const recoverFromStreamFailure = async (session: PlaybackSession, positionSec: number): Promise<boolean> => {
    const requestId = ++playRequestRef.current;
    const failedUrls = [...session.failedUrls, session.source.streamUrl];
    console.warn(`[App] stream failed for ${session.anime.title} E${session.episode.number}, looking for another server (${failedUrls.length} failed so far)`);
    setStreamLoading(true);
    try {
      const source = await getEpisodeStream(
        session.anime.id || session.anime.title,
        session.episode.id || session.episode.number,
        session.mode,
        session.anime.id,
        { excludeStreamUrls: failedUrls }
      );
      if (requestId !== playRequestRef.current) return true; // user moved on
      // The demo clip is not a substitute for an episode that was playing.
      if (source.isFallback || failedUrls.includes(source.streamUrl)) return false;
      const startTime = Math.max(0, positionSec);
      setNowPlaying({ ...session, source, startTime, failedUrls });
      if (Capacitor.isNativePlatform()) {
        await playNative(session.anime, session.episode, session.mode, source, episodeListRef.current, startTime);
      }
      return true;
    } catch (err) {
      console.warn('[App] server fallback failed:', err);
      return requestId !== playRequestRef.current;
    } finally {
      if (requestId === playRequestRef.current) setStreamLoading(false);
    }
  };
  const recoverRef = useRef(recoverFromStreamFailure);
  recoverRef.current = recoverFromStreamFailure;

  // Play an episode
  const handlePlayEpisode = async (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub' = 'sub',
    startTime = 0
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

    // Real episode list for this anime, used for hasNextEpisode/next-episode
    // lookups and the native player's episode picker - only re-fetched when
    // the anime actually changes (advancing to the next episode of the same
    // anime reuses what's already loaded). Fetched in parallel with the
    // stream itself but awaited before use, so the very first episode
    // played for a given anime doesn't race a stale/empty list into the
    // native "Episodes" button.
    const needsEpisodeList = loadedEpisodeListAnimeId.current !== anime.id;
    const episodeListPromise = needsEpisodeList
      ? getEpisodes(anime.id || anime.title).then(eps => [...eps].sort((a, b) => parseFloat(a.number) - parseFloat(b.number)))
      : Promise.resolve(episodeListRef.current);

    try {
      const [source, resolvedEpisodeList] = await Promise.all([
        getEpisodeStream(anime.id || anime.title, episode.id || episode.number, mode, anime.id),
        episodeListPromise
      ]);

      // The user picked something else meanwhile, or closed the player.
      if (requestId !== playRequestRef.current) return;

      if (needsEpisodeList) {
        setEpisodeList(resolvedEpisodeList);
        loadedEpisodeListAnimeId.current = anime.id;
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
      setNowPlaying({ anime, episode, mode, source, startTime, failedUrls: [] });

      if (isNative) {
        try {
          console.log("[App] Launching Android Native ExoPlayer...");
          await playNative(anime, episode, mode, source, resolvedEpisodeList, startTime);
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
      const message = "Could not load this episode. Please try another episode or server.";
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
    const matchedAnime = FEATURED_ANIME.find(a => a.id === historyItem.animeId) || {
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

    // Resuming a finished episode used to drop the viewer straight into its
    // end credits (and the next-episode countdown) - start it over instead.
    const startAt = isEpisodeFinished(historyItem) ? 0 : historyItem.currentTime;
    handlePlayEpisode(matchedAnime, resumeEpisode, historyItem.mode, startAt);
  };

  // Progress handler bound to one committed session: the player captures it
  // per stream, so its final report on an episode change still lands on
  // the episode that was actually playing.
  const handleProgressUpdate = useMemo(() => {
    if (!nowPlaying) return undefined;
    const session = nowPlaying;
    return (time: number, dur: number, streamUrl: string) => {
      if (streamUrl !== session.source.streamUrl) return;
      saveSessionProgress(session, time, dur);
    };
  }, [nowPlaying]);

  const closeWebPlayer = () => {
    // Also drop any stream still resolving, so it can't reopen the player
    // a moment after the user backed out.
    playRequestRef.current++;
    setStreamLoading(false);
    setIsPlaying(false);
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
            paused={isPlaying}
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
      {isPlaying && nowPlaying && (
        <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999 }} />}>
        <VideoPlayer
          streamSource={nowPlaying.source}
          animeTitle={nowPlaying.anime.title}
          episode={nowPlaying.episode}
          mode={nowPlaying.mode}
          initialTime={nowPlaying.startTime}
          onBack={closeWebPlayer}
          onNextEpisode={handleNextEpisode}
          hasNextEpisode={hasNextEpisode}
          episodeList={episodeList}
          onSelectEpisode={(ep) => handlePlayEpisode(nowPlaying.anime, ep, playingMode, 0)}
          onSwitchMode={(newMode) => handlePlayEpisode(nowPlaying.anime, nowPlaying.episode, newMode, 0)}
          onProgressUpdate={handleProgressUpdate}
          onStreamFailed={(positionSec) => recoverFromStreamFailure(nowPlaying, positionSec)}
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
