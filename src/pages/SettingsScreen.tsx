// SettingsScreen.tsx - Playback preferences, data management, and app info
import React, { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon, PlayCircle, SkipForward, Rewind, Trash2,
  Info, Terminal, Bookmark, Clock, ChevronRight
} from 'lucide-react';
import {
  getUserPreferences, saveUserPreferences, clearWatchHistory,
  getWatchHistory, getBookmarks,
  type UserPreferences
} from '../services/historyService';
import { Preferences } from '@capacitor/preferences';

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
      color: '#818cf8',
      flexShrink: 0
    }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>{label}</h4>
      <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>{description}</p>
    </div>
    <div className={`toggle-switch ${value ? 'on' : ''}`}>
      <div className="knob" />
    </div>
  </div>
);

export const SettingsScreen: React.FC = () => {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [bookmarkCount, setBookmarkCount] = useState<number>(0);
  const [clearing, setClearing] = useState<boolean>(false);

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
    if (!window.confirm('Clear your entire watch history? This cannot be undone.')) return;
    setClearing(true);
    await clearWatchHistory();
    setHistoryCount(0);
    setClearing(false);
  };

  const handleClearBookmarks = async () => {
    if (!window.confirm('Remove all saved bookmarks?')) return;
    await Preferences.remove({ key: 'anistream_bookmarks' });
    setBookmarkCount(0);
  };

  if (!prefs) {
    return <div style={{ flex: 1 }} />;
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
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#f8fafc' }}>Settings</h1>
        </div>
      </div>

      <div style={{ padding: '20px' }}>
        {/* Default Playback Mode */}
        <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
          Playback
        </h2>

        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          {/* Default mode segmented control */}
          <div style={{ padding: '16px 16px 10px 16px' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc', marginBottom: '10px' }}>Default Audio</h4>
            <div style={{
              display: 'flex',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 'var(--radius-full)',
              padding: '4px'
            }}>
              <button
                onClick={() => updatePrefs({ defaultMode: 'sub' })}
                className="interactive"
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  backgroundColor: prefs.defaultMode === 'sub' ? '#6366f1' : 'transparent',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 700
                }}
              >
                Subtitled (SUB)
              </button>
              <button
                onClick={() => updatePrefs({ defaultMode: 'dub' })}
                className="interactive"
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  backgroundColor: prefs.defaultMode === 'dub' ? '#a855f7' : 'transparent',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 700
                }}
              >
                Dubbed (DUB)
              </button>
            </div>
          </div>

          {/* Default quality */}
          <div style={{ padding: '14px 16px 16px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc', marginBottom: '10px' }}>Default Quality</h4>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {QUALITIES.map(q => (
                <button
                  key={q}
                  onClick={() => updatePrefs({ defaultQuality: q })}
                  className="interactive glass-pill"
                  style={{
                    padding: '7px 16px',
                    borderRadius: 'var(--radius-full)',
                    border: prefs.defaultQuality === q ? '1px solid #6366f1' : 'none',
                    backgroundColor: prefs.defaultQuality === q ? 'rgba(99, 102, 241, 0.25)' : undefined,
                    color: prefs.defaultQuality === q ? '#818cf8' : '#cbd5e1',
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
            description="Jump past the opening automatically"
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
        <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
          Data
        </h2>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <button
            onClick={handleClearHistory}
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
              background: 'rgba(244, 63, 94, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#fb7185', flexShrink: 0
            }}>
              <Clock size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>Clear Watch History</h4>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>{historyCount} items stored</p>
            </div>
            <Trash2 size={16} color="#fb7185" />
          </button>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <button
            onClick={handleClearBookmarks}
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
              background: 'rgba(244, 63, 94, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#fb7185', flexShrink: 0
            }}>
              <Bookmark size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>Clear Bookmarks</h4>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>{bookmarkCount} saved</p>
            </div>
            <Trash2 size={16} color="#fb7185" />
          </button>
        </div>

        {/* About Section */}
        <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' }}>
          About
        </h2>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#818cf8', flexShrink: 0
            }}>
              <PlayCircle size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>AniStream</h4>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>Version 1.0.0</p>
            </div>
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#818cf8', flexShrink: 0
            }}>
              <Terminal size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>Powered by ani-cli</h4>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>Streams resolved through the ani-cli scraping engine</p>
            </div>
            <ChevronRight size={16} color="#64748b" />
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(99, 102, 241, 0.14)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#818cf8', flexShrink: 0
            }}>
              <Info size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>Disclaimer</h4>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>AniStream does not host any media. All content is fetched from third-party sources.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
