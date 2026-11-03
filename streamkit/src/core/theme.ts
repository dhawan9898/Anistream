// theme.ts - Theme persistence shared by both apps. Each app supplies its own
// storage key and list of themes; the store keeps Capacitor Preferences as the
// source of truth and mirrors the value into localStorage so it can be read
// synchronously before first paint (no flash of the wrong theme).
import { Preferences } from '@capacitor/preferences';

export interface ThemeStoreOptions<T extends string> {
  /** Preferences key, e.g. 'anistream_theme'. */
  key: string;
  /** localStorage key read synchronously (and written as a mirror). */
  syncKey: string;
  themes: readonly T[];
  fallback: T;
}

export interface ThemeStore<T extends string> {
  getSync(): T;
  get(): Promise<T>;
  set(theme: T): Promise<void>;
  /** Sets data-theme on <html> and the browser theme-color meta tag. */
  apply(theme: T, metaColors?: Partial<Record<T, string>>): void;
}

export function createThemeStore<T extends string>(opts: ThemeStoreOptions<T>): ThemeStore<T> {
  const valid = (v: string | null | undefined): v is T => !!v && (opts.themes as readonly string[]).includes(v);

  const getSync = (): T => {
    try {
      const raw = window.localStorage.getItem(opts.syncKey);
      return valid(raw) ? raw : opts.fallback;
    } catch {
      return opts.fallback;
    }
  };

  return {
    getSync,
    async get() {
      try {
        const { value } = await Preferences.get({ key: opts.key });
        return valid(value) ? value : getSync();
      } catch {
        return getSync();
      }
    },
    async set(theme) {
      try { window.localStorage.setItem(opts.syncKey, theme); } catch { /* storage unavailable */ }
      await Preferences.set({ key: opts.key, value: theme });
    },
    apply(theme, metaColors) {
      document.documentElement.setAttribute('data-theme', theme);
      const color = metaColors?.[theme];
      if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    }
  };
}
