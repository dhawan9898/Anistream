// SettingsScreen.tsx - Appearance, playback preferences, data management, and app info
import React, { useEffect, useState, useRef } from 'react';
import {
  PlayCircle, SkipForward, Rewind, Trash2,
  Info, Terminal, Bookmark, Clock, Loader2, Vibrate, Droplets,
  RefreshCw, DownloadCloud, Bug, Upload, Download, ChevronRight
} from 'lucide-react';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../services/updateService';
import {
  getUserPreferences, saveUserPreferences, clearWatchHistory,
  getWatchHistory, getBookmarks, exportBackup, importBackup,
  type UserPreferences
} from '../services/historyService';
import { Capacitor } from '@capacitor/core';
import { CloudAccountCard } from '../components/CloudAccountCard.tsx';
import { DownloadsPlugin } from '../plugins/downloadsPlugin';
import { THEME_OPTIONS, type ThemeMode } from '../services/themeService';
import { getGlassStyle, setGlassStyle } from '../services/glassService';
import { Preferences } from '@capacitor/preferences';
import { ConfirmModal } from 'streamkit/ui/ConfirmModal.tsx';
import {
  hapticToggle,
  hapticMedium,
  hapticSelection,
  hapticSuccess,
  hapticWarning,
  getHapticSettings,
  saveHapticSettings,
  type HapticIntensity
} from '../services/hapticsService';

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
    onClick={() => {
      hapticToggle(!value);
      onToggle();
    }}
    role="button"
    tabIndex={0}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        hapticToggle(!value);
        onToggle();
      }
    }}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      padding: '16px 18px',
      userSelect: 'none'
    }}
  >
    <div style={{
      width: '40px',
      height: '40px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--accent-soft)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--accent-primary)',
      flexShrink: 0
    }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{label}</h4>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', lineHeight: 1.35 }}>{description}</p>
    </div>
    <div
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`toggle-switch ${value ? 'on' : ''}`}
    >
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
  // True while this tab is the visible one (tabs stay mounted when hidden).
  active: boolean;
  theme: ThemeMode;
  onChangeTheme: (theme: ThemeMode) => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ active, theme, onChangeTheme }) => {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [bookmarkCount, setBookmarkCount] = useState<number>(0);
  const [haptics, setHaptics] = useState(getHapticSettings);
  const [glassClear, setGlassClear] = useState(() => getGlassStyle() === 'clear');
  const [clearing, setClearing] = useState<boolean>(false);
  const [confirmingClearHistory, setConfirmingClearHistory] = useState<boolean>(false);
  const [confirmingClearBookmarks, setConfirmingClearBookmarks] = useState<boolean>(false);

  // Counts are re-read whenever the tab is opened.
  useEffect(() => {
    if (!active) return;
    getUserPreferences().then(setPrefs);
    getWatchHistory().then(list => setHistoryCount(list.length));
    getBookmarks().then(list => setBookmarkCount(list.length));
  }, [active]);

  // In-app updater
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setUpdateChecking(true);
    setUpdateStatus(null);
    try {
      const info = await checkForUpdate('dhawan9898/Anistream');
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus(`Update available: v${info.version}`);
      } else {
        setUpdateInfo(null);
        setUpdateStatus('AniStream is up to date.');
      }
    } catch (err: any) {
      setUpdateStatus(`Update check failed: ${err?.message || 'Network error'}`);
    } finally {
      setUpdateChecking(false);
    }
  };

  // Crash reporting & backup
  const [crashReport, setCrashReport] = useState<string | null>(null);
  const [crashCopied, setCrashCopied] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    DownloadsPlugin.getCrashReport().then(res => {
      if (res.report) setCrashReport(res.report);
    }).catch(() => {});
  }, []);

  const handleCopyClearCrash = async () => {
    if (!crashReport) return;
    try {
      await navigator.clipboard.writeText(crashReport);
      await DownloadsPlugin.clearCrashReport();
      setCrashReport(null);
      setCrashCopied(true);
      setTimeout(() => setCrashCopied(false), 3000);
    } catch {}
  };

  const handleExportBackup = async () => {
    try {
      const json = await exportBackup();
      const name = `anistream-backup-${new Date().toISOString().slice(0, 10)}.json`;
      if (Capacitor.isNativePlatform()) {
        // A file link clicked inside the app's WebView saves nothing: the file is written natively.
        const { location } = await DownloadsPlugin.saveTextFile({ name, text: json });
        setBackupStatus(`Backup saved to ${location}`);
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setBackupStatus('Backup exported');
      }
      setTimeout(() => setBackupStatus(null), 6000);
    } catch (err) {
      setBackupStatus(`Export failed: ${err instanceof Error ? err.message : 'Error'}`);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        await importBackup(text);
        const [h, b, p] = await Promise.all([getWatchHistory(), getBookmarks(), getUserPreferences()]);
        setHistoryCount(h.length);
        setBookmarkCount(b.length);
        setPrefs(p);
        setBackupStatus('Backup imported successfully');
        setTimeout(() => setBackupStatus(null), 3000);
      } catch (err: any) {
        setBackupStatus(`Import failed: ${err?.message || 'Invalid format'}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo) return;
    setUpdateDownloading(true);
    setUpdateProgress(0);
    try {
      await installUpdate(updateInfo.apkUrl, pct => setUpdateProgress(pct), updateInfo.size);
      setUpdateStatus('Update downloaded. Launching package installer...');
    } catch (err: any) {
      setUpdateStatus(`Update failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setUpdateDownloading(false);
    }
  };

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
    hapticSuccess();
  };

  const handleClearBookmarks = async () => {
    setConfirmingClearBookmarks(false);
    await Preferences.remove({ key: 'anistream_bookmarks' });
    setBookmarkCount(0);
    hapticSuccess();
  };

  if (!prefs) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 size={28} className="animate-spin" color="var(--accent-primary)" />
      </div>
    );
  }

  return (
    <div className="screen-scroll" style={{ paddingBottom: '108px' }}>
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
              {THEME_OPTIONS.map(t => (
                <button
                  key={t.id}
                  onClick={() => { hapticMedium(); onChangeTheme(t.id); }}
                  className={`interactive seg-pill ${theme === t.id ? 'active' : ''}`}
                  style={{ padding: '8px 4px', fontSize: '13px' }}
                >
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <ToggleRow
              icon={<Droplets size={20} />}
              label="Transparent Glass"
              description="Floating bars, buttons and tiles turn see-through instead of blurred."
              value={glassClear}
              onToggle={() => { const next = !glassClear; setGlassClear(next); setGlassStyle(next ? 'clear' : 'frosted'); }}
            />
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
                onClick={() => { hapticMedium(); updatePrefs({ defaultMode: 'sub' }); }}
                className={`interactive seg-pill ${prefs.defaultMode === 'sub' ? 'active' : ''}`}
              >
                Subtitled (SUB)
              </button>
              <button
                onClick={() => { hapticMedium(); updatePrefs({ defaultMode: 'dub' }); }}
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
                  onClick={() => { hapticSelection(); updatePrefs({ defaultQuality: q }); }}
                  className={`interactive glass-pill chip ${prefs.defaultQuality === q ? 'active' : ''}`}
                  style={{
                    padding: '8px 18px',
                    borderRadius: 'var(--radius-sm)',
                    color: prefs.defaultQuality === q ? undefined : 'var(--text-secondary)',
                    fontSize: '13px',
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
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <ToggleRow
            icon={<PlayCircle size={18} />}
            label="Subtitles & Captions"
            description="Display subtitles automatically whenever available"
            value={prefs.subtitlesEnabled !== false}
            onToggle={() => updatePrefs({ subtitlesEnabled: prefs.subtitlesEnabled === false })}
          />
        </div>

        {/* Downloads */}
        <SectionLabel>Downloads</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <div style={{ padding: '16px' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Download Quality</h4>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.35 }}>
              Highest video quality saved for offline viewing. Lower qualities use much less storage.
            </p>
            <div className="seg-track">
              {(['1080', '720', '480'] as const).map(q => (
                <button
                  key={q}
                  onClick={() => { hapticSelection(); updatePrefs({ downloadQuality: q }); }}
                  className={`interactive seg-pill ${(prefs.downloadQuality || '720') === q ? 'active' : ''}`}
                >
                  {q}p
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Haptics */}
        <SectionLabel>Haptic Feedback</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <ToggleRow
            icon={<Vibrate size={20} />}
            label="Vibration"
            description="Short vibrations when you tap, switch or confirm something."
            value={haptics.enabled}
            onToggle={() => setHaptics(saveHapticSettings({ enabled: !haptics.enabled }))}
          />
          <div style={{ padding: '4px 16px 16px 16px', opacity: haptics.enabled ? 1 : 0.45 }}>
            <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>Intensity</h4>
            <div className="seg-track">
              {(['low', 'medium', 'high'] as HapticIntensity[]).map(level => (
                <button
                  key={level}
                  disabled={!haptics.enabled}
                  onClick={() => { setHaptics(saveHapticSettings({ intensity: level })); hapticMedium(); }}
                  className={`interactive seg-pill ${haptics.intensity === level ? 'active' : ''}`}
                >
                  {level === 'low' ? 'Low' : level === 'medium' ? 'Medium' : 'High'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Data Section */}
        <SectionLabel>Data</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: '24px' }}>
          <button
            onClick={() => { hapticWarning(); setConfirmingClearHistory(true); }}
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
            onClick={() => { hapticWarning(); setConfirmingClearBookmarks(true); }}
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
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <button
            onClick={handleExportBackup}
            className="interactive"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              background: 'none',
              border: 'none'
            }}
          >
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <Download size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Export Backup</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Save your watch history, bookmarks, and settings</p>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </button>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="interactive"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '14px 16px',
              background: 'none',
              border: 'none'
            }}
          >
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <Upload size={18} />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Import Backup</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Restore data from an exported JSON file</p>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
          {backupStatus && (
            <div style={{ padding: '10px 16px', background: 'var(--accent-soft)', borderTop: '1px solid var(--border-subtle)', fontSize: '13px', color: 'var(--accent-primary)', fontWeight: 600 }}>
              {backupStatus}
            </div>
          )}
        </div>

        <CloudAccountCard spacing={24} />

        {crashReport && (
          <div style={{ marginBottom: '24px' }}>
            <SectionLabel>Crash Report</SectionLabel>
            <div className="glass-panel" style={{ borderRadius: 'var(--radius-lg)', padding: '16px', border: '1px solid var(--accent-danger)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <Bug size={18} color="var(--accent-danger)" />
                <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>App Crash Detected</h4>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: 1.4 }}>
                The app closed unexpectedly earlier. Copies the diagnostic log to share with the developer.
              </p>
              <pre style={{
                maxHeight: '120px',
                overflowY: 'auto',
                fontSize: '11px',
                color: 'var(--text-muted)',
                background: 'rgba(0,0,0,0.3)',
                padding: '8px',
                borderRadius: '6px',
                marginBottom: '12px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
              }}>
                {crashReport}
              </pre>
              <button
                className="interactive btn-primary"
                onClick={handleCopyClearCrash}
                style={{ width: '100%', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'var(--accent-danger)' }}
              >
                <Bug size={16} />
                {crashCopied ? 'Copied & Cleared!' : 'Copy & Clear Crash Report'}
              </button>
            </div>
          </div>
        )}

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

        {/* App Updates Section */}
        <div style={{ marginBottom: '24px' }}>
          <SectionLabel>App Updates</SectionLabel>
          <div className="glass-panel" style={{ borderRadius: 'var(--radius-lg)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div>
                <h4 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>AniStream</h4>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Installed: v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '10.15.0'}
                </p>
              </div>
              <button
                className="interactive seg-pill"
                disabled={updateChecking || updateDownloading}
                onClick={() => { hapticMedium(); handleCheckUpdate(); }}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <RefreshCw size={14} className={updateChecking ? 'animate-spin' : ''} />
                {updateChecking ? 'Checking...' : 'Check for Updates'}
              </button>
            </div>

            {updateStatus && (
              <p style={{ fontSize: '12px', color: updateInfo ? 'var(--accent-primary)' : 'var(--text-secondary)', marginBottom: '8px' }}>
                {updateStatus}
              </p>
            )}

            {updateInfo && (
              <div style={{ marginTop: '12px', padding: '12px', borderRadius: 'var(--radius-md)', background: 'var(--accent-soft)', border: '1px solid var(--accent-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                    New Version: v{updateInfo.version}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {updateInfo.publishedAt ? new Date(updateInfo.publishedAt).toLocaleDateString() : ''}
                  </span>
                </div>
                {updateInfo.releaseNotes && (
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', maxHeight: '80px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                    {updateInfo.releaseNotes}
                  </p>
                )}
                {updateProgress !== null && (
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ height: '4px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${updateProgress}%`, background: 'var(--accent-primary)', transition: 'width 0.2s' }} />
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                      Downloading APK: {updateProgress.toFixed(0)}%
                    </span>
                  </div>
                )}
                <button
                  className="interactive btn-primary"
                  disabled={updateDownloading}
                  onClick={() => { hapticMedium(); handleInstallUpdate(); }}
                  style={{ width: '100%', marginTop: '10px', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                >
                  <DownloadCloud size={16} />
                  {updateDownloading ? 'Downloading & Installing...' : 'Download & Install Update'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* About Section */}
        <SectionLabel>About</SectionLabel>
        <div className="glass-panel animate-pop-in" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <PlayCircle size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>AniStream</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Version {__APP_VERSION__}</p>
            </div>
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--accent-primary)', flexShrink: 0
            }}>
              <Terminal size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Powered by ani-cli</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>Streams resolved through the ani-cli scraping engine</p>
            </div>
          </div>
          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', display: 'flex', alignItems: 'center',
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
