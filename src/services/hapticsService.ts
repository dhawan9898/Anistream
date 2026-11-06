// hapticsService.ts - Tactile feedback for taps, toggles and confirmations.
//
// Feedback can be switched off and its strength chosen in Settings. The
// preference is kept in localStorage (read synchronously: feedback fires in
// click handlers and must not wait on storage) and defaults to a gentle
// level - the platform's stock "impact" presets felt far too strong.
//
// On Android every effect is one short vibration whose length scales with the
// chosen intensity; on browsers that expose it the Vibration API is used the
// same way; elsewhere this is a no-op.
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

export type HapticIntensity = 'low' | 'medium' | 'high';

export interface HapticSettings {
  enabled: boolean;
  intensity: HapticIntensity;
}

export const DEFAULT_HAPTIC_SETTINGS: HapticSettings = { enabled: true, intensity: 'low' };

const STORAGE_KEY = 'anistream:haptics';

// Multiplier on each effect's base length (ms).
const INTENSITY_SCALE: Record<HapticIntensity, number> = { low: 0.6, medium: 1, high: 1.7 };

let settings: HapticSettings = loadSettings();

function isIntensity(v: unknown): v is HapticIntensity {
  return v === 'low' || v === 'medium' || v === 'high';
}

function loadSettings(): HapticSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<HapticSettings>;
      return {
        enabled: parsed.enabled !== false,
        intensity: isIntensity(parsed.intensity) ? parsed.intensity : DEFAULT_HAPTIC_SETTINGS.intensity
      };
    }
  } catch {
    // Unreadable storage or bad JSON: use the defaults.
  }
  return { ...DEFAULT_HAPTIC_SETTINGS };
}

export const getHapticSettings = (): HapticSettings => ({ ...settings });

export function saveHapticSettings(patch: Partial<HapticSettings>): HapticSettings {
  settings = {
    enabled: patch.enabled ?? settings.enabled,
    intensity: isIntensity(patch.intensity) ? patch.intensity : settings.intensity
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted (private mode / storage full); still applies this session.
  }
  return getHapticSettings();
}

const isSupported = (): boolean =>
  Capacitor.isNativePlatform() || (typeof navigator !== 'undefined' && 'vibrate' in navigator);

// One vibration of `baseMs` (scaled by intensity), or a pattern of them.
async function pulse(baseMs: number | number[]): Promise<void> {
  if (!settings.enabled || !isSupported()) return;
  const scale = INTENSITY_SCALE[settings.intensity];
  const scaled = Array.isArray(baseMs)
    ? baseMs.map(ms => Math.max(1, Math.round(ms * scale)))
    : Math.max(1, Math.round(baseMs * scale));
  try {
    if (Capacitor.isNativePlatform()) {
      // Patterns collapse to their first pulse on native: a single clean tick.
      await Haptics.vibrate({ duration: Array.isArray(scaled) ? scaled[0] : scaled });
    } else {
      navigator.vibrate(scaled);
    }
  } catch {
    // Ignore any platform errors
  }
}

/** Subtle tap: tab switches, chips, carousel dots. */
export const hapticLight = (): Promise<void> => pulse(8);

/** Primary buttons (Play, Back, Sub/Dub). */
export const hapticMedium = (): Promise<void> => pulse(12);

/** Opening cards, modal actions. */
export const hapticHeavy = (): Promise<void> => pulse(18);

/** Switch flipped on (slightly longer) or off. */
export const hapticToggle = (checked: boolean): Promise<void> => pulse(checked ? 12 : 8);

/** Picker / slider tick. */
export const hapticSelection = (): Promise<void> => pulse(5);

/** Confirmation: bookmarked, saved. */
export const hapticSuccess = (): Promise<void> => pulse([8, 40, 10]);

/** A confirmation prompt or caution. */
export const hapticWarning = (): Promise<void> => pulse([12, 30, 16]);

/** A failure. */
export const hapticError = (): Promise<void> => pulse([18, 40, 18, 40, 24]);
