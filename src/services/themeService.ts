// themeService.ts - Dark/light theme persistence
import { Preferences } from '@capacitor/preferences';

export type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'anistream_theme';

// Synchronous best-effort read so the theme can be applied to <html> before
// first paint (avoids a flash of the wrong theme). Preferences on web is
// backed by localStorage, so this mirrors what getTheme() will resolve to;
// on native it's a fallback until the async Preferences read completes.
export function getStoredThemeSync(): ThemeMode {
  try {
    const raw = window.localStorage.getItem('CapacitorStorage.' + THEME_KEY);
    return raw === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export async function getTheme(): Promise<ThemeMode> {
  try {
    const { value } = await Preferences.get({ key: THEME_KEY });
    return value === 'light' ? 'light' : 'dark';
  } catch {
    return getStoredThemeSync();
  }
}

export async function setTheme(theme: ThemeMode): Promise<void> {
  await Preferences.set({ key: THEME_KEY, value: theme });
}
