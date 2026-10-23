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
  getEpisodes,
  SourceUnavailableError,
  type AnimeItem,
  type EpisodeItem,
  type StreamSource
} from './core/aniCliCore';
import { resolveStream } from './services/streamResolver';
import { handleLayerBack } from './services/backStack';
import {
  saveWatchProgress,
  getUserPreferences,
  setPlaybackActive,
  isEpisodeFinished,
  DEFAULT_PREFERENCES,
  type UserPreferences,
  type WatchHistoryItem
} from './services/historyService';
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

// Applies the "Default Quality" preference when the stream actually offers
// more than one distinct rendition to choose from.
function applyPreferredQuality(source: StreamSource, prefs: UserPreferences): StreamSource {
  const preferred = source.qualities?.find(q => q.quality === prefs.defaultQuality);
  if (preferred && preferred.url !== source.streamUrl) {
    return { ...source, streamUrl: preferred.url, quality: preferred.quality };
  }
  return source;
}

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

// How long a closing screen keeps sliding out before it is removed.
const OVERLAY_EXIT_MS = 240;

// A screen that has been popped but is still animating out. It keeps the key
// it had while open, so React reuses the same DOM node and only the class
// changes - the slide-out starts from exactly where the screen was.
interface ClosingOverlay {
  key: string;
  anime?: AnimeItem;
  genre?: Genre;
}

const animeKey = (depth: number, anime: AnimeItem) => `detail-${depth}-${anime.id}`;
const genreKey = (genre: Genre) => `genre-${genre.slug}`;

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<Tab>('home');
  // Tabs are mounted the first time they are visited and then kept alive
  // (hidden, not destroyed), so coming back to one keeps its scroll position
  // and loaded content instead of rebuilding and refetching it.
  const [mountedTabs, setMountedTabs] = useState<Record<Tab, boolean>>({
    home: true, search: false, library: false, settings: false
  });
  // Title pages stack up (opening a suggestion from a title page and backing
  // out returns to the previous title, like Netflix); a genre page sits
  // underneath them. Both slide over the tabs instead of replacing them.
  const [animeStack, setAnimeStack] = useState<AnimeItem[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [closing, setClosing] = useState<ClosingOverlay[]>([]);
  const animeStackRef = useRef<AnimeItem[]>([]);
  const selectedGenreRef = useRef<Genre | null>(null);
  const currentTabRef = useRef<Tab>('home');

  const closingTimers = useRef<number[]>([]);
  useEffect(() => () => closingTimers.current.forEach(t => window.clearTimeout(t)), []);

  const updateStack = (next: AnimeItem[]) => {
    animeStackRef.current = next;
    setAnimeStack(next);
  };
  const updateGenre = (next: Genre | null) => {
    selectedGenreRef.current = next;
    setSelectedGenre(next);
  };
  const startClosing = (overlay: ClosingOverlay) => {
    setClosing(list => [...list.filter(c => c.key !== overlay.key), overlay]);
    closingTimers.current.push(window.setTimeout(() => {
      setClosing(list => list.filter(c => c.key !== overlay.key));
    }, OVERLAY_EXIT_MS + 60));
  };

  const pushAnime = (anime: AnimeItem) => {
    const stack = animeStackRef.current;
    const key = animeKey(stack.length, anime);
    setClosing(list => list.filter(c => c.key !== key));
    updateStack([...stack, anime]);
  };
  const popAnime = () => {
    const stack = animeStackRef.current;
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    startClosing({ key: animeKey(stack.length - 1, top), anime: top });
    updateStack(stack.slice(0, -1));
  };
  const openGenre = (genre: Genre) => {
    updateStack([]);
    setClosing([]);
    updateGenre(genre);
  };
  const closeGenre = () => {
    const genre = selectedGenreRef.current;
    if (!genre) return;
    startClosing({ key: genreKey(genre), genre });
    updateGenre(null);
  };
  const switchTab = (tab: Tab) => {
    updateStack([]);
    updateGenre(null);
    setClosing([]);
    currentTabRef.current = tab;
    setCurrentTab(tab);
    setMountedTabs(prev => (prev[tab] ? prev : { ...prev, [tab]: true }));
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
  // The native player is open (also while it is still resolving a stream).
  const [nativeOpen, setNativeOpen] = useState<boolean>(false);
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

  // While anything plays, screens underneath don't react to each progress
  // save (see historyService.setPlaybackActive).
  useEffect(() => {
    setPlaybackActive(nativeOpen || isPlaying);
  }, [nativeOpen, isPlaying]);

  const prefsRef = useRef<UserPreferences>(DEFAULT_PREFERENCES);
  useEffect(() => {
    getUserPreferences().then(p => { prefsRef.current = p; });
  }, []);

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
  // re-resolve a stream themselves - they notify us here so we can resolve
  // again and hand the player the new stream. Read anime/episode from
  // refs, not state: this effect subscribes once (empty deps), so closing
  // over the state variables directly would only ever see their initial
  // (null) values.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    // Every request from the native player must end in play() or fail():
    // a silent return here used to leave the player spinning on its
    // loading screen until it was closed.
    const failInPlayer = (message: string) => {
      console.warn('[App] native request could not be served:', message);
      ExoPlayerPlugin.fail({ message }).catch(() => undefined);
    };
    const modeHandle = ExoPlayerPlugin.addListener('modeSwitchRequested', ({ mode, positionMs }) => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (!anime || !episode) {
        failInPlayer("Couldn't switch audio for this episode. Go back and pick it again.");
        return;
      }
      // Continue from the same point in the other audio track.
      handlePlayEpisode(anime, episode, mode, Math.max(0, (positionMs || 0) / 1000));
    });
    // The player started the prefetched next episode itself. Record it as
    // the playing episode (progress reports for it are matched against
    // nowPlaying) and prefetch the one after it.
    const nextStartedHandle = ExoPlayerPlugin.addListener('nextEpisodeStarted', ({ episode: number, mode }) => {
      const anime = playingAnimeRef.current;
      const list = episodeListRef.current;
      const episode = list.find(e => e.number === number);
      if (!anime || !episode) return; // already playing natively; nothing to sync
      const requestId = ++playRequestRef.current; // supersede anything in flight
      const prefetched = prefetchedNextRef.current;
      prefetchedNextRef.current = null;
      setStreamLoading(false);
      setPlayingEpisode(episode);
      setPlayingMode(mode);
      playingEpisodeRef.current = episode;
      playingModeRef.current = mode;
      // Progress for the new episode is only saved against a committed
      // session. Without the prefetched source (it should always be there)
      // reuse the previous one just to carry the "not a demo clip" fact.
      const matching = prefetched && prefetched.animeId === anime.id
        && prefetched.episode.id === episode.id && prefetched.mode === mode;
      const source = matching ? prefetched.source : nowPlayingRef.current?.source;
      if (source) {
        const session = { anime, episode, mode, source, startTime: 0 };
        nowPlayingRef.current = session;
        setNowPlaying(session);
      }
      prefetchNext(anime, episode, mode, list, requestId);
    });
    const nextEpHandle = ExoPlayerPlugin.addListener('nextEpisodeRequested', ({ episode: currentNumber }) => {
      const anime = playingAnimeRef.current;
      const list = episodeListRef.current;
      // By the number the player was showing first (it is the authority on
      // what is on screen), then by the episode JS thinks is playing.
      const byNumber = list.findIndex(e => e.number === currentNumber);
      const next = (byNumber >= 0 ? list[byNumber + 1] : undefined)
        ?? findNextEpisode(playingEpisodeRef.current, list);
      if (!anime || !next) {
        failInPlayer("Couldn't find the next episode. Go back and pick it from the list.");
        return;
      }
      handlePlayEpisode(anime, next, playingModeRef.current, 0);
    });
    const episodeSelectedHandle = ExoPlayerPlugin.addListener('episodeSelected', ({ selectedNumber }) => {
      const anime = playingAnimeRef.current;
      const selected = episodeListRef.current.find(e => e.number === selectedNumber);
      if (!anime || !selected) {
        failInPlayer(`Couldn't load episode ${selectedNumber}. Go back and pick it from the list.`);
        return;
      }
      // Re-picking the episode that is already showing is the player's
      // "Retry" - that must not reuse a stream that just stalled.
      const retry = selectedNumber === playingEpisodeRef.current?.number;
      handlePlayEpisode(anime, selected, playingModeRef.current, 0, { fresh: retry });
    });
    // The stream hit an HTTP error (e.g. 404): look the same episode up
    // again - exactly what closing and reopening it does - and resume.
    const reloadHandle = ExoPlayerPlugin.addListener('reloadRequested', ({ episode, mode, positionMs }) => {
      const session = nowPlayingRef.current;
      if (!session || episode !== session.episode.number || (mode && mode !== session.mode)) {
        failInPlayer("Couldn't reload this episode. Go back and pick it again.");
        return;
      }
      console.warn(`[App] reloading ${session.anime.title} E${episode} after a stream error`);
      handlePlayEpisode(session.anime, session.episode, session.mode, Math.max(0, positionMs / 1000), { fresh: true });
    });
    // The native player is the only place playback position lives - unlike
    // the web <VideoPlayer>, which reports progress via its own
    // onProgressUpdate prop, native has no such prop path (it isn't even
    // mounted while native plays), so watch history only gets saved if we
    // save it here, from this bridged event.
    const closedHandle = ExoPlayerPlugin.addListener('playerClosed', () => {
      playRequestRef.current++;
      prefetchedNextRef.current = null;
      setStreamLoading(false);
      setNativeOpen(false);
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
      nextStartedHandle.then(h => h.remove());
      nextEpHandle.then(h => h.remove());
      episodeSelectedHandle.then(h => h.remove());
      reloadHandle.then(h => h.remove());
      progressHandle.then(h => h.remove());
      closedHandle.then(h => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nativePlayOptions = (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub',
    source: StreamSource,
    episodes: EpisodeItem[],
    startTime: number,
    prefs: UserPreferences
  ) => ({
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
    spriteVtt: source.spriteVtt,
    startPositionMs: Math.max(0, Math.round(startTime * 1000)),
    autoSkipIntro: prefs.autoSkipIntro,
    autoPlayNext: prefs.autoPlayNext,
    hasDub: anime.dubCount === undefined ? true : anime.dubCount > 0
  });

  // The next episode's stream, resolved ahead of time and handed to the
  // native player, which starts it by itself when Next Episode is pressed
  // (or the countdown ends). Best effort - without a prefetched stream the
  // player falls back to asking JS (nextEpisodeRequested), which joins this
  // same resolution if it is still running (see streamResolver).
  const prefetchedNextRef = useRef<{ animeId: string; episode: EpisodeItem; mode: 'sub' | 'dub'; source: StreamSource } | null>(null);
  const prefetchNext = async (
    anime: AnimeItem,
    current: EpisodeItem,
    mode: 'sub' | 'dub',
    episodes: EpisodeItem[],
    requestId: number
  ) => {
    const next = findNextEpisode(current, episodes);
    if (!next) return;
    try {
      const prefs = prefsRef.current;
      const source = applyPreferredQuality(await resolveStream(anime, next, mode), prefs);
      // Moved on meanwhile, or nothing real to hand over.
      if (requestId !== playRequestRef.current || source.isFallback) return;
      prefetchedNextRef.current = { animeId: anime.id, episode: next, mode, source };
      await ExoPlayerPlugin.setNextEpisode({
        ...nativePlayOptions(anime, next, mode, source, episodes, 0, prefs),
        afterEpisode: current.number
      });
      console.log(`[App] prefetched E${next.number} (${mode}) for the player`);
    } catch (err) {
      console.warn('[App] next-episode prefetch failed (player will ask when needed):', err);
    }
  };

  // Play an episode
  const handlePlayEpisode = async (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub' = 'sub',
    startTime = 0,
    options: { fresh?: boolean } = {}
  ) => {
    const requestId = ++playRequestRef.current;
    const isNative = Capacitor.isNativePlatform();
    setStreamLoading(true);
    // Native: open the player right away in its loading state (title +
    // spinner) instead of a blocking overlay here; the stream is handed to
    // that same player once resolved. For next episode / audio switch the
    // player is already open and simply shows its spinner again.
    if (isNative) {
      setNativeOpen(true);
      ExoPlayerPlugin.open({ title: anime.title, episode: episode.number, mode }).catch(err =>
        console.warn('[App] ExoPlayer open failed:', err));
    }
    setPlayingAnime(anime);
    setPlayingEpisode(episode);
    setPlayingMode(mode);
    playingAnimeRef.current = anime;
    playingEpisodeRef.current = episode;
    playingModeRef.current = mode;

    // Real episode list for this anime, used for hasNextEpisode/next-episode
    // lookups and the native player's episode picker - only re-fetched when
    // the anime actually changes (advancing to the next episode of the same
    // anime reuses what's already loaded). Fetched in parallel with the
    // stream itself but awaited before use, so the very first episode
    // played for a given anime doesn't race a stale/empty list into the
    // native "Episodes" button.
    const needsEpisodeList = loadedEpisodeListAnimeId.current !== anime.id;
    const episodeListPromise = needsEpisodeList
      // The list only powers next/episode picker - if it fails, still play
      // the episode that was asked for (and retry the list next time).
      ? getEpisodes(anime.id || anime.title).catch(err => {
          console.warn('[App] episode list unavailable, playing without it:', err);
          return null;
        })
      : Promise.resolve(episodeListRef.current);

    try {
      const [rawSource, resolvedEpisodeList, prefs] = await Promise.all([
        resolveStream(anime, episode, mode, { fresh: options.fresh }),
        episodeListPromise,
        getUserPreferences()
      ]);
      prefsRef.current = prefs;

      // The user picked something else meanwhile, or closed the player.
      if (requestId !== playRequestRef.current) return;

      const episodesForPlayer = resolvedEpisodeList ?? [];
      if (needsEpisodeList) {
        setEpisodeList(episodesForPlayer);
        episodeListRef.current = episodesForPlayer;
        loadedEpisodeListAnimeId.current = resolvedEpisodeList ? anime.id : null;
      }

      const source = applyPreferredQuality(rawSource, prefs);
      const session: PlaybackSession = { anime, episode, mode, source, startTime };
      nowPlayingRef.current = session;
      setNowPlaying(session);

      if (isNative) {
        try {
          console.log("[App] Launching Android Native ExoPlayer...");
          await ExoPlayerPlugin.play(nativePlayOptions(anime, episode, mode, source, episodesForPlayer, startTime, prefs));
          // Resolve the following episode now and hand it to the player
          // (see prefetchNext).
          if (!source.isFallback) prefetchNext(anime, episode, mode, episodesForPlayer, requestId);
        } catch (e) {
          console.warn("[App] ExoPlayer plugin call failed:", e);
          // The native player is already open on its loading screen: report
          // the failure there rather than starting a second, hidden player.
          ExoPlayerPlugin.fail({ message: "Couldn't start the player. Please try again." })
            .catch(() => { setNativeOpen(false); setStreamErrorMessage("Couldn't start the player. Please try again."); });
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
        ExoPlayerPlugin.fail({ message }).catch(() => { setNativeOpen(false); setStreamErrorMessage(message); });
      } else {
        setStreamErrorMessage(message);
      }
    } finally {
      if (requestId === playRequestRef.current) setStreamLoading(false);
    }
  };

  // Continue Watching / Library history: open the title page (with its
  // Resume button, episode list, etc.) rather than starting playback.
  const handleOpenFromHistory = (historyItem: WatchHistoryItem) => {
    const anime: AnimeItem = {
      id: historyItem.animeId,
      title: historyItem.animeTitle,
      poster: historyItem.poster,
      type: 'TV'
    };
    pushAnime(anime);
  };

  // Library: play that very episode, continuing where it was left.
  const handlePlayFromHistory = (item: WatchHistoryItem) => {
    handlePlayEpisode(
      { id: item.animeId, title: item.animeTitle, poster: item.poster, type: 'TV' },
      { id: item.episodeId, number: item.episodeNumber, title: `Episode ${item.episodeNumber}` },
      item.mode,
      isEpisodeFinished(item) ? 0 : item.currentTime
    );
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

  // ---- Android back gesture / button ----
  // Screens are in-memory state, not URLs. MainActivity asks the web layer
  // what "back" should do by calling window.__anistreamBack(): it closes the
  // top-most thing - an open dialog/picker, the web player, a title page, a
  // genre page, then any tab other than Home (-> Home) - and answers true.
  // On plain Home it answers false and Android sends the app to the
  // background (like pressing Home) rather than closing it.
  const backStepRef = useRef<() => boolean>(() => false);
  backStepRef.current = () => {
    if (handleLayerBack()) return true;
    if (isPlaying) { closeWebPlayer(); return true; }
    if (animeStackRef.current.length > 0) { popAnime(); return true; }
    if (selectedGenreRef.current) { closeGenre(); return true; }
    if (currentTabRef.current !== 'home') { switchTab('home'); return true; }
    return false;
  };

  useEffect(() => {
    const w = window as unknown as { __anistreamBack?: () => boolean };
    w.__anistreamBack = () => backStepRef.current();
    return () => { delete w.__anistreamBack; };
  }, []);

  // In a regular browser (dev / web build) the browser's own Back button is
  // the only back action, so one history "guard" entry is kept while
  // anything is open on top of Home and popstate steps back through it.
  const atRoot = !isPlaying && streamErrorMessage === null && animeStack.length === 0
    && !selectedGenre && currentTab === 'home';
  const backGuardRef = useRef(false);
  const ignoredPopsRef = useRef(0);
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!atRoot && !backGuardRef.current) {
      window.history.pushState({ anistreamBackGuard: true }, '');
      backGuardRef.current = true;
    } else if (atRoot && backGuardRef.current) {
      backGuardRef.current = false;
      ignoredPopsRef.current++;
      window.history.back();
    }
  });
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const onPopState = () => {
      if (ignoredPopsRef.current > 0) {
        ignoredPopsRef.current--;
        return;
      }
      backGuardRef.current = false;
      backStepRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Screens underneath a covering layer (or player) stop animating/polling.
  const covered = isPlaying || nativeOpen || animeStack.length > 0 || !!selectedGenre;
  const dockHidden = isPlaying || animeStack.length > 0;

  const renderOverlays = () => {
    const nodes: React.ReactNode[] = [];
    const push = (key: string, leaving: boolean, node: React.ReactNode) => {
      nodes.push(<div key={key} className={leaving ? 'overlay leaving' : 'overlay'}>{node}</div>);
    };

    // Genre page (open, or sliding out)
    if (selectedGenre) {
      push(genreKey(selectedGenre), false, (
        <GenreScreen
          genre={selectedGenre}
          onBack={closeGenre}
          onSelectGenre={openGenre}
          onSelectAnime={pushAnime}
        />
      ));
    }
    closing.filter(c => c.genre).forEach(c => push(c.key, true, (
      <GenreScreen genre={c.genre!} onBack={() => undefined} onSelectGenre={() => undefined} onSelectAnime={() => undefined} />
    )));

    // Title pages, bottom to top, then the ones sliding out above them.
    animeStack.forEach((anime, depth) => {
      push(animeKey(depth, anime), false, (
        <AnimeDetailScreen
          anime={anime}
          onBack={popAnime}
          onPlayEpisode={(a, ep, mode) => handlePlayEpisode(a, ep, mode)}
          onResume={(a, item) => handlePlayEpisode(
            a,
            { id: item.episodeId, number: item.episodeNumber, title: `Episode ${item.episodeNumber}` },
            item.mode,
            item.currentTime
          )}
          onSelectAnime={pushAnime}
        />
      ));
    });
    closing.filter(c => c.anime).forEach(c => push(c.key, true, (
      <AnimeDetailScreen
        anime={c.anime!}
        onBack={() => undefined}
        onPlayEpisode={() => undefined}
        onResume={() => undefined}
        onSelectAnime={() => undefined}
      />
    )));
    return nodes;
  };

  const tabPane = (tab: Tab, node: React.ReactNode) => (
    mountedTabs[tab] ? (
      <div key={tab} className="tab-pane" data-active={currentTab === tab}>
        {node}
      </div>
    ) : null
  );

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
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {tabPane('home', (
          <HomeScreen
            onSelectAnime={pushAnime}
            onResumeEpisode={handleOpenFromHistory}
            onOpenSearch={() => switchTab('search')}
            onSelectGenre={openGenre}
            paused={covered || currentTab !== 'home'}
          />
        ))}
        {tabPane('search', (
          <SearchScreen
            active={currentTab === 'search' && !covered}
            onBack={() => switchTab('home')}
            onSelectAnime={pushAnime}
            onSelectGenre={openGenre}
          />
        ))}
        {tabPane('library', (
          <HistoryScreen
            active={currentTab === 'library' && !covered}
            onPlayHistoryItem={handlePlayFromHistory}
            onSelectAnime={pushAnime}
          />
        ))}
        {tabPane('settings', (
          <SettingsScreen active={currentTab === 'settings' && !covered} theme={theme} onChangeTheme={handleSetTheme} />
        ))}

        {renderOverlays()}
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
          onSwitchMode={(newMode, positionSec) => handlePlayEpisode(nowPlaying.anime, nowPlaying.episode, newMode, positionSec)}
          onProgressUpdate={handleProgressUpdate}
        />
        </Suspense>
      )}

      {/* Floating dock (slides away while a title page or the player is
          open). A liquid-glass pane with a sliding indicator behind the active
          tab. It is the only blurred element over scrolling content, and it is
          small and fixed, so the blur stays cheap. */}
      <div
        className={dockHidden ? 'dock-wrap hidden' : 'dock-wrap'}
        style={{ bottom: 'calc(16px + var(--safe-bottom))' }}
        aria-hidden={dockHidden}
      >
        <nav className="glass-dock" aria-label="Main">
          <div
            className="dock-indicator"
            style={{
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
                onClick={() => { if (!active || animeStack.length || selectedGenre) switchTab(tab.id); }}
                className={`interactive dock-item ${active ? 'active' : ''}`}
                aria-label={tab.label}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={20} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
};

export default App;
