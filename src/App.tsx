// App.tsx - Main Android Application Controller for AniStream
import React, { useState, useEffect, useRef } from 'react';
import { Home as HomeIcon, Search as SearchIcon, Library, Settings as SettingsIcon, Loader2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ExoPlayerPlugin } from './plugins/exoPlayerPlugin';
import { HomeScreen } from './pages/HomeScreen';
import { SearchScreen } from './pages/SearchScreen';
import { AnimeDetailScreen } from './pages/AnimeDetailScreen';
import { HistoryScreen } from './pages/HistoryScreen';
import { SettingsScreen } from './pages/SettingsScreen';
import { VideoPlayer } from './components/VideoPlayer';
import { ConfirmModal } from './components/ConfirmModal';
import {
  getEpisodeStream,
  getEpisodes,
  type AnimeItem,
  type EpisodeItem,
  type StreamSource,
  FEATURED_ANIME
} from './core/aniCliCore';
import { saveWatchProgress, getUserPreferences, type WatchHistoryItem } from './services/historyService';
import { getTheme, getStoredThemeSync, setTheme as persistTheme, type ThemeMode } from './services/themeService';

type Tab = 'home' | 'search' | 'library' | 'settings';

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<Tab>('home');
  const [selectedAnime, setSelectedAnime] = useState<AnimeItem | null>(null);
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
    const progressHandle = ExoPlayerPlugin.addListener('progressUpdate', ({ positionMs, durationMs }) => {
      const anime = playingAnimeRef.current;
      const episode = playingEpisodeRef.current;
      if (!anime || !episode || durationMs <= 0) return;
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Play an episode
  const handlePlayEpisode = async (
    anime: AnimeItem,
    episode: EpisodeItem,
    mode: 'sub' | 'dub' = 'sub',
    startTime = 0
  ) => {
    setStreamLoading(true);
    setPlayingAnime(anime);
    setPlayingEpisode(episode);
    setPlayingMode(mode);
    setInitialSeekTime(startTime);

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

      setStreamSource(source);

      if (Capacitor.isNativePlatform()) {
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
            episodes: resolvedEpisodeList.map(e => ({ id: e.id, number: e.number })),
            isFallback: source.isFallback,
            intro: source.intro,
            outro: source.outro
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
      setStreamErrorMessage("Could not load stream from ani-cli. Please try another episode or server.");
    } finally {
      setStreamLoading(false);
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
      width: '100vw',
      height: '100vh',
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
        key={selectedAnime ? `detail-${selectedAnime.id}` : currentTab}
        className={selectedAnime ? 'animate-slide-in' : 'animate-fade-in'}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        {selectedAnime ? (
          <AnimeDetailScreen
            anime={selectedAnime}
            onBack={() => setSelectedAnime(null)}
            onPlayEpisode={(ep, mode) => handlePlayEpisode(selectedAnime, ep, mode)}
          />
        ) : currentTab === 'home' ? (
          <HomeScreen
            onSelectAnime={(anime) => setSelectedAnime(anime)}
            onResumeEpisode={handleResumeEpisode}
            onOpenSearch={() => setCurrentTab('search')}
          />
        ) : currentTab === 'search' ? (
          <SearchScreen
            onBack={() => setCurrentTab('home')}
            onSelectAnime={(anime) => setSelectedAnime(anime)}
          />
        ) : currentTab === 'library' ? (
          <HistoryScreen
            onResumeEpisode={handleResumeEpisode}
            onSelectAnime={(anime) => setSelectedAnime(anime)}
          />
        ) : (
          <SettingsScreen theme={theme} onChangeTheme={handleSetTheme} />
        )}
      </div>

      {/* Stream Loading Overlay */}
      {streamLoading && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(var(--bg-main-rgb), 0.85)',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          zIndex: 10000
        }}>
          <div style={{
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            background: 'var(--accent-gradient)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-glow)'
          }}>
            <Loader2 size={32} color="#fff" className="animate-spin" />
          </div>
          <div style={{ textAlign: 'center' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Resolving ani-cli Stream...
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Deobfuscating ZokoAnime server payload
            </p>
          </div>
        </div>
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
          onProgressUpdate={(time, dur) => {
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
                  onClick={() => setCurrentTab(tab.id)}
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
