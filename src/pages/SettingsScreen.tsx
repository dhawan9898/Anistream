// SettingsScreen.tsx - Laid out like CineStream's and Mangapill's: Appearance, Playback, Downloads,
// Haptic Feedback, Data, About (with updates).
import React, { useEffect, useState, useRef } from 'react';
import {
  PlayCircle, SkipForward, Rewind, Captions,
  Info, Bookmark, Clock, Loader2, Vibrate, Droplets,
  RefreshCw, DownloadCloud, Bug, Upload, Download, ChevronRight
} from 'lucide-react';
import { checkForUpdate, installUpdate } from '../services/updateService';
import { SettingsSection, SettingsRow, ChoiceRow, Switch, RowValue, SettingsNote, UpdateRows } from 'streamkit/ui/Settings.tsx';
import {
  getUserPreferences, saveUserPreferences, clearWatchHistory,
  getWatchHistory, getBookmarks, exportBackup, importBackup,
  type UserPreferences
} from '../services/historyService';
import { Capacitor } from '@capacitor/core';
import { AccountAvatarButton } from '../components/AccountAvatarButton.tsx';
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

const QUALITIES = [
  { id: 'Auto', label: 'Auto' }, { id: '1080p', label: '1080p' }, { id: '720p', label: '720p' }, { id: '480p', label: '480p' }
] as const;
const AUTO_DOWNLOAD_OPTIONS = [{ id: '0', label: 'Off' }, { id: '1', label: '1' }, { id: '2', label: '2' }, { id: '3', label: '3' }] as const;
const DOWNLOAD_QUALITIES = [{ id: '1080', label: '1080p' }, { id: '720', label: '720p' }, { id: '480', label: '480p' }] as const;
const HAPTIC_LEVELS: readonly { id: HapticIntensity; label: string }[] = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }
];

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

  const toggle = (on: boolean, change: () => void) => () => { hapticToggle(!on); change(); };

  return (
    <div className="screen-scroll" style={{ paddingBottom: '108px' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 30, backgroundColor: 'var(--bg-main)',
        padding: 'calc(var(--safe-top) + 16px) 20px 14px 20px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Settings</h1>
        <AccountAvatarButton />
      </div>

      <div style={{ padding: '20px 16px' }}>
        <SettingsSection title="Appearance">
          <ChoiceRow first title="Theme" options={THEME_OPTIONS} value={theme} onSelect={t => { hapticMedium(); onChangeTheme(t); }} />
          <SettingsRow
            icon={<Droplets size={18} />}
            title="Transparent Glass"
            hint="Bars, buttons and tiles turn see-through instead of blurred"
            onClick={toggle(glassClear, () => { const next = !glassClear; setGlassClear(next); setGlassStyle(next ? 'clear' : 'frosted'); })}
            trailing={<Switch on={glassClear} label="Transparent Glass" />}
          />
        </SettingsSection>

        <SettingsSection title="Playback">
          <ChoiceRow
            first
            title="Default Audio"
            options={[{ id: 'sub', label: 'Subtitled' }, { id: 'dub', label: 'Dubbed' }] as const}
            value={prefs.defaultMode}
            onSelect={m => { hapticMedium(); updatePrefs({ defaultMode: m }); }}
          />
          <ChoiceRow
            title="Default Quality"
            options={QUALITIES}
            value={prefs.defaultQuality}
            onSelect={q => { hapticSelection(); updatePrefs({ defaultQuality: q }); }}
          />
          <SettingsRow
            icon={<Rewind size={18} />}
            title="Auto-Skip Intro"
            hint="Jump past the opening when it is known"
            onClick={toggle(prefs.autoSkipIntro, () => updatePrefs({ autoSkipIntro: !prefs.autoSkipIntro }))}
            trailing={<Switch on={prefs.autoSkipIntro} label="Auto-Skip Intro" />}
          />
          <SettingsRow
            icon={<SkipForward size={18} />}
            title="Autoplay Next Episode"
            hint="Continue to the next episode when one ends"
            onClick={toggle(prefs.autoPlayNext, () => updatePrefs({ autoPlayNext: !prefs.autoPlayNext }))}
            trailing={<Switch on={prefs.autoPlayNext} label="Autoplay Next Episode" />}
          />
          <SettingsRow
            icon={<Captions size={18} />}
            title="Subtitles"
            hint="Shown automatically when available"
            onClick={toggle(prefs.subtitlesEnabled !== false, () => updatePrefs({ subtitlesEnabled: prefs.subtitlesEnabled === false }))}
            trailing={<Switch on={prefs.subtitlesEnabled !== false} label="Subtitles" />}
          />
        </SettingsSection>

        <SettingsSection title="Downloads">
          <ChoiceRow
            first
            title="Download Quality"
            hint="Highest quality saved for offline viewing. Lower uses much less storage."
            options={DOWNLOAD_QUALITIES}
            value={prefs.downloadQuality || '720'}
            onSelect={q => { hapticSelection(); updatePrefs({ downloadQuality: q }); }}
          />
          <ChoiceRow
            title="Auto-Download Next Episodes"
            hint="After half an episode, save the next ones so a binge or a flight is ready"
            options={AUTO_DOWNLOAD_OPTIONS}
            value={String(prefs.autoDownloadNext ?? 0)}
            onSelect={v => { hapticSelection(); updatePrefs({ autoDownloadNext: Number(v) }); }}
          />
          <SettingsRow
            icon={<DownloadCloud size={18} />}
            title="Wi-Fi Only"
            hint="Never use mobile data for automatic downloads"
            onClick={toggle(prefs.autoDownloadWifiOnly !== false, () => updatePrefs({ autoDownloadWifiOnly: prefs.autoDownloadWifiOnly === false }))}
            trailing={<Switch on={prefs.autoDownloadWifiOnly !== false} label="Wi-Fi Only" />}
          />
          <SettingsRow
            icon={<Download size={18} />}
            title="Delete After Watching"
            hint="Free the space once an episode is finished"
            onClick={toggle(!!prefs.deleteWatched, () => updatePrefs({ deleteWatched: !prefs.deleteWatched }))}
            trailing={<Switch on={!!prefs.deleteWatched} label="Delete After Watching" />}
          />
        </SettingsSection>

        <SettingsSection title="Haptic Feedback">
          <SettingsRow
            first
            icon={<Vibrate size={18} />}
            title="Vibration"
            hint="Short vibrations when you tap, switch or confirm"
            onClick={toggle(haptics.enabled, () => setHaptics(saveHapticSettings({ enabled: !haptics.enabled })))}
            trailing={<Switch on={haptics.enabled} label="Vibration" />}
          />
          <ChoiceRow
            title="Intensity"
            options={HAPTIC_LEVELS}
            value={haptics.intensity}
            disabled={!haptics.enabled}
            onSelect={level => { setHaptics(saveHapticSettings({ intensity: level })); hapticMedium(); }}
          />
        </SettingsSection>

        <SettingsSection title="Data">
          <SettingsRow
            first
            icon={<Download size={18} />}
            title="Export Backup"
            hint="Save history, bookmarks and settings to a file"
            onClick={() => { hapticSelection(); void handleExportBackup(); }}
            trailing={<ChevronRight size={16} color="var(--text-muted)" />}
          />
          <SettingsRow
            icon={<Upload size={18} />}
            title="Import Backup"
            hint="Restore from a saved backup file"
            onClick={() => { hapticSelection(); fileInputRef.current?.click(); }}
            trailing={<ChevronRight size={16} color="var(--text-muted)" />}
          />
          <SettingsRow
            danger
            icon={<Clock size={18} />}
            title="Clear Watch History"
            hint="Forgets where you stopped in every title"
            disabled={clearing || historyCount === 0}
            onClick={() => { hapticWarning(); setConfirmingClearHistory(true); }}
            trailing={<RowValue>{historyCount}</RowValue>}
          />
          <SettingsRow
            danger
            icon={<Bookmark size={18} />}
            title="Clear Bookmarks"
            hint="Removes every saved title"
            disabled={bookmarkCount === 0}
            onClick={() => { hapticWarning(); setConfirmingClearBookmarks(true); }}
            trailing={<RowValue>{bookmarkCount}</RowValue>}
          />
          {crashReport && (
            <SettingsRow
              danger
              icon={<Bug size={18} />}
              title={crashCopied ? 'Crash report copied' : 'Copy Last Crash Report'}
              hint="The app closed unexpectedly earlier. Copies what happened for the developer."
              onClick={() => void handleCopyClearCrash()}
            />
          )}
          {backupStatus && <SettingsNote>{backupStatus}</SettingsNote>}
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsRow
            first
            icon={<PlayCircle size={18} />}
            title="AniStream"
            hint="Anime streaming, powered by the ani-cli engine"
            trailing={<RowValue>v{__APP_VERSION__}</RowValue>}
          />
          <UpdateRows
            appName="AniStream"
            version={__APP_VERSION__}
            icon={<RefreshCw size={18} />}
            installIcon={<DownloadCloud size={16} />}
            check={() => checkForUpdate('dhawan9898/Anistream')}
            install={installUpdate}
            onTap={hapticMedium}
          />
          <SettingsRow
            icon={<Info size={18} />}
            title="Disclaimer"
            hint="AniStream does not host any media. Everything is fetched from third-party sources."
          />
        </SettingsSection>

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
      </div>
    </div>
  );
};
