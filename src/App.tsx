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
import {
  getEpisodeStream,
  type AnimeItem,
  type EpisodeItem,
  type StreamSource,
  FEATURED_ANIME
} from './core/aniCliCore';
import { saveWatchProgress, type WatchHistoryItem } from './services/historyService';
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

  // Kept in refs so the native mode-switch listener (subscribed once) always
  // sees the currently playing anime/episode without re-subscribing.
  const playingAnimeRef = useRef<AnimeItem | null>(null);
  const playingEpisodeRef = useRef<EpisodeItem | null>(null);
  const playingModeRef = useRef<'sub' | 'dub'>('sub');
  playingAnimeRef.current = playingAnime;
  playingEpisodeRef.current = playingEpisode;
  playingModeRef.current = playingMode;

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
      const nextEpNum = String(parseInt(episode.number, 10) + 1);
      const nextEp: EpisodeItem = {
        id: `${anime.id}-ep-${nextEpNum}`,
        number: nextEpNum,
        title: `Episode ${nextEpNum}`
      };
      handlePlayEpisode(anime, nextEp, playingModeRef.current, 0);
    });
    return () => {
      modeHandle.then(h => h.remove());
      nextEpHandle.then(h => h.remove());
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

    try {
      const source = await getEpisodeStream(anime.id || anime.title, episode.id || episode.number, mode, anime.id);
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
            qualities: source.qualities
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
      alert("Could not load stream from ani-cli. Please try another episode or server.");
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

  // Next episode handler
  const handleNextEpisode = () => {
    if (!playingEpisode || !playingAnime) return;
    const nextEpNum = String(parseInt(playingEpisode.number, 10) + 1);
    const nextEp: EpisodeItem = {
      id: `${playingAnime.id}-ep-${nextEpNum}`,
      number: nextEpNum,
      title: `Episode ${nextEpNum}`
    };
    handlePlayEpisode(playingAnime, nextEp, playingMode, 0);
  };

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
          hasNextEpisode={true}
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
