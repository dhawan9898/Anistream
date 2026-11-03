// themeService.ts - AniStream's theme persistence (dark / light), built on the
// shared theme store.
import { createThemeStore } from 'streamkit/core/theme.ts';

export type ThemeMode = 'dark' | 'light';

const store = createThemeStore<ThemeMode>({
  key: 'anistream_theme',
  // Capacitor Preferences on web writes this exact key; index.html reads it
  // before first paint.
  syncKey: 'CapacitorStorage.anistream_theme',
  themes: ['dark', 'light'],
  fallback: 'dark'
});

export const getStoredThemeSync = store.getSync;
export const getTheme = store.get;
export const setTheme = store.set;
