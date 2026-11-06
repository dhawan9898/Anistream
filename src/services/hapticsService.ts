// hapticsService.ts - Apple Taptic Engine feedback coordinator using Capacitor Haptics
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

// Safe wrapper that works seamlessly on Native Android/iOS and falls back
// to Web Vibration API or graceful no-op on desktop browsers.
const isSupported = (): boolean => {
  return Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'vibrate' in navigator);
};

/**
 * Subtle tactile tap: ideal for tab bar switches, segmented controls, carousel dots,
 * and quick filter chips. Mimics iOS UIImpactFeedbackGenerator(style: .light).
 */
export const hapticLight = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.impact({ style: ImpactStyle.Light });
    } else if (navigator.vibrate) {
      navigator.vibrate(8);
    }
  } catch {
    // Ignore any platform errors
  }
};

/**
 * Medium crisp impact: ideal for primary buttons (Play, Watch Now, Back, Sub/Dub toggle).
 * Mimics iOS UIImpactFeedbackGenerator(style: .medium).
 */
export const hapticMedium = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.impact({ style: ImpactStyle.Medium });
    } else if (navigator.vibrate) {
      navigator.vibrate(14);
    }
  } catch {
    // Ignore any platform errors
  }
};

/**
 * Firm impact: ideal for opening anime cards, modal actions, and heavy interactions.
 * Mimics iOS UIImpactFeedbackGenerator(style: .heavy).
 */
export const hapticHeavy = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.impact({ style: ImpactStyle.Heavy });
    } else if (navigator.vibrate) {
      navigator.vibrate(22);
    }
  } catch {
    // Ignore any platform errors
  }
};

/**
 * Tactile toggle click: distinct dual-pulse feeling when flipping a switch on/off.
 */
export const hapticToggle = async (checked: boolean): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      if (checked) {
        await Haptics.impact({ style: ImpactStyle.Medium });
      } else {
        await Haptics.impact({ style: ImpactStyle.Light });
      }
    } else if (navigator.vibrate) {
      navigator.vibrate(checked ? [10, 30, 15] : [12]);
    }
  } catch {
    // Ignore any platform errors
  }
};

/**
 * Selection tick: subtle click for pickers, sliders, and range selectors.
 * Mimics iOS UISelectionFeedbackGenerator.
 */
export const hapticSelection = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.selectionChanged();
    } else if (navigator.vibrate) {
      navigator.vibrate(6);
    }
  } catch {
    // Fall back to light impact if selectionChanged isn't implemented on platform
    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch {
      // Ignore
    }
  }
};

/**
 * Success notification: pleasant confirmation for bookmarking to My List or saving settings.
 * Mimics iOS UINotificationFeedbackGenerator(type: .success).
 */
export const hapticSuccess = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.notification({ type: NotificationType.Success });
    } else if (navigator.vibrate) {
      navigator.vibrate([10, 40, 15]);
    }
  } catch {
    // Ignore
  }
};

/**
 * Warning notification: alerts the user to an issue or confirmation prompt.
 */
export const hapticWarning = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.notification({ type: NotificationType.Warning });
    } else if (navigator.vibrate) {
      navigator.vibrate([15, 30, 25]);
    }
  } catch {
    // Ignore
  }
};

/**
 * Error notification: alerts the user to a failure.
 */
export const hapticError = async (): Promise<void> => {
  if (!isSupported()) return;
  try {
    if (Capacitor.isNativePlatform()) {
      await Haptics.notification({ type: NotificationType.Error });
    } else if (navigator.vibrate) {
      navigator.vibrate([30, 40, 30, 40, 40]);
    }
  } catch {
    // Ignore
  }
};
