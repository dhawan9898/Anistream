// SettingsScreen.tsx - Appearance, playback preferences, data management, and app info
import React, { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon, PlayCircle, SkipForward, Rewind, Trash2,
  Info, Terminal, Bookmark, Clock, ChevronRight, Sun, Moon, Loader2
} from 'lucide-react';
import {
  getUserPreferences, saveUserPreferences, clearWatchHistory,
  getWatchHistory, getBookmarks,
  type UserPreferences
} from '../services/historyService';
import type { ThemeMode } from '../services/themeService';
import { Preferences } from '@capacitor/preferences';
import { ConfirmModal } from '../components/ConfirmModal';

const QUALITIES = ['480p', '720p', '1080p', 'Auto'];

interface ToggleRowProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ icon, label, description, value, onToggle }) => (
  <div
    className="interactive"
    onClick={onToggle}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      padding: '14px 16px'
    }}
  >
    <div style={{
      width: '38px',
      height: '38px',
      borderRadius: 'var(--radius-sm)',
      background: 'rgba(99, 102, 241, 0.14)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--accent-primary)',
      flexShrink: 0
    }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</h4>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{description}</p>
    </div>
    <div className={`toggle-switch ${value ? 'on' : ''}`}>
      <div className="knob" />
    </div>
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h2 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
    {children}
  </h2>
);

interface SettingsScreenProps {
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ theme, onChangeTheme }) => {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [bookmarkCount, setBookmarkCount] = useState<number>(0);
  const [clearing, setClearing] = useState<boolean>(false);
  const [confirmingClearHistory, setConfirmingClearHistory] = useState<boolean>(false);
  const [confirmingClearBookmarks, setConfirmingClearBookmarks] = useState<boolean>(false);

  useEffect(() => {
    getUserPreferences().then(setPrefs);
    getWatchHistory().then(list => setHistoryCount(list.length));
    getBookmarks().then(list => setBookmarkCount(list.length));
  }, []);

  const updatePrefs = async (patch: Partial<UserPreferences>) => {
    setPrefs(prev => prev ? { ...prev, ...patch } : prev);
    await saveUserPreferences(patch);
  };

  const handleClearHistory = async () => {
    setConfirmingClearHistory(false);
    setClearing(true);
    await clearWatchHistory();
    setHistoryCount(0);
    setClearing(false);
  };

  const handleClearBookmarks = async () => {
    setConfirmingClearBookmarks(false);
    await Preferences.remove({ key: 'anistream_bookmarks' });
    setBookmarkCount(0);
  };

  if (!prefs) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={28} className="animate-spin" color="var(--accent-primary)" />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '110px' }}>
      {/* Header */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        backgroundColor: 'var(--bg-main)',
        padding: 'calc(var(--safe-top) + 16px) 20px 14px 20px',
        borderBottom: '1px solid var(--border-subtle)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-gradient)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-glow)'
          }}>
            <SettingsIcon size={18} color="#fff" />
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Settings</h1>
        </div>
      </div>

      <div style={{ padding: '20px' }}>
        {/* Appearance */}
        <SectionLabel>Appearance</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <div style={{ padding: '16px' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Theme</h4>
            <div className="seg-track">
              <button
                onClick={() => onChangeTheme('dark')}
                className={`interactive seg-pill ${theme === 'dark' ? 'active' : ''}`}
              >
                <Moon size={15} />
                <span>Dark</span>
              </button>
              <button
                onClick={() => onChangeTheme('light')}
                className={`interactive seg-pill ${theme === 'light' ? 'active' : ''}`}
              >
                <Sun size={15} />
                <span>Light</span>
              </button>
            </div>
          </div>
        </div>

        {/* Playback */}
        <SectionLabel>Playback</SectionLabel>

        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          {/* Default mode segmented control */}
          <div style={{ padding: '16px 16px 10px 16px' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Default Audio</h4>
            <div className="seg-track">
              <button
                onClick={() => updatePrefs({ defaultMode: 'sub' })}
                className={`interactive seg-pill ${prefs.defaultMode === 'sub' ? 'active' : ''}`}
              >
                Subtitled (SUB)
              </button>
              <button
                onClick={() => updatePrefs({ defaultMode: 'dub' })}
                className={`interactive seg-pill ${prefs.defaultMode === 'dub' ? 'active' : ''}`}
              >
                Dubbed (DUB)
              </button>
            </div>
          </div>

          {/* Default quality */}
          <div style={{ padding: '14px 16px 16px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Default Quality</h4>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {QUALITIES.map(q => (
                <button
                  key={q}
                  onClick={() => updatePrefs({ defaultQuality: q })}
                  className={`interactive glass-pill chip ${prefs.defaultQuality === q ? 'active' : ''}`}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 'var(--radius-full)',
                    color: prefs.defaultQuality === q ? undefined : 'var(--text-secondary)',
                    fontSize: '12px',
                    fontWeight: 700
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          <ToggleRow
            icon={<Rewind size={18} />}
            label="Auto-Skip Intro"
            description="Jump straight past the opening when playback starts"
            value={prefs.autoSkipIntro}
            onToggle={() => updatePrefs({ autoSkipIntro: !prefs.autoSkipIntro })}
          />
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <ToggleRow
            icon={<SkipForward size={18} />}
            label="Autoplay Next Episode"
            description="Continue to the next episode when one ends"
            value={prefs.autoPlayNext}
            onToggle={() => updatePrefs({ autoPlayNext: !prefs.autoPlayNext })}
          />
        </div>

        {/* Data Section */}
        <SectionLabel>Data</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <button
            onClick={() => setConfirmingClearHistory(true)}
            disabled={clearing || historyCount === 0}
            className="interactive"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              background: 'none',
              border: 'none',
              opacity: historyCount === 0 ? 0.5 : 1
            }}
          >
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-danger-bg)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-danger)', flexShrink: 0
            }}>
              <Clock size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Clear Watch History</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{historyCount} items stored</p>
            </div>
            <Trash2 size={16} color="var(--accent-danger)" />
          </button>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <button
            onClick={() => setConfirmingClearBookmarks(true)}
            disabled={bookmarkCount === 0}
            className="interactive"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              background: 'none',
              border: 'none',
              opacity: bookmarkCount === 0 ? 0.5 : 1
            }}
          >
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-danger-bg)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-danger)', flexShrink: 0
            }}>
              <Bookmark size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Clear Bookmarks</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{bookmarkCount} saved</p>
            </div>
            <Trash2 size={16} color="var(--accent-danger)" />
          </button>
        </div>

        <ConfirmModal
          open={confirmingClearHistory}
          title="Clear Watch History"
          message="Clear your entire watch history? This cannot be undone."
          confirmLabel="Clear"
          cancelLabel="Cancel"
          danger
          onConfirm={handleClearHistory}
          onCancel={() => setConfirmingClearHistory(false)}
        />
        <ConfirmModal
          open={confirmingClearBookmarks}
          title="Clear Bookmarks"
          message="Remove all saved bookmarks? This cannot be undone."
          confirmLabel="Clear"
          cancelLabel="Cancel"
          danger
          onConfirm={handleClearBookmarks}
          onCancel={() => setConfirmingClearBookmarks(false)}
        />

        {/* About Section */}
        <SectionLabel>About</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <PlayCircle size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>AniStream</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Version 4.0.0</p>
            </div>
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <Terminal size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Powered by ani-cli</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Streams resolved through the ani-cli scraping engine</p>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <Info size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Disclaimer</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>AniStream does not host any media. All content is fetched from third-party sources.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
