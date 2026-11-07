// themeService.ts - AniStream's theme persistence (dark / OLED / slate / light), built on the
// shared theme store.
import { createThemeStore } from 'streamkit/core/theme.ts';

export type ThemeMode = 'dark' | 'obsidian' | 'slate' | 'light';

/** Themes in the order Settings lists them. */
export const THEME_OPTIONS: readonly { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'obsidian', label: 'OLED' },
  { id: 'slate', label: 'Slate' },
  { id: 'light', label: 'Light' }
];

/** Browser/status-bar colour per theme. */
export const THEME_META_COLORS: Record<ThemeMode, string> = {
  dark: '#0b0b0d',
  obsidian: '#000000',
  slate: '#0a1120',
  light: '#f1f2f6'
};

const store = createThemeStore<ThemeMode>({
  key: 'anistream_theme',
  // Capacitor Preferences on web writes this exact key; index.html reads it
  // before first paint.
  syncKey: 'CapacitorStorage.anistream_theme',
  themes: ['dark', 'obsidian', 'slate', 'light'],
  fallback: 'dark'
});

export const getStoredThemeSync = store.getSync;
export const getTheme = store.get;
export const setTheme = store.set;
