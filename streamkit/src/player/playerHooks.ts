// playerHooks.ts - Small browser-integration hooks used by the web player.
import { useEffect } from 'react';

// Keep the screen awake while playing (Screen Wake Lock API, where the
// browser/WebView has it). The lock is dropped automatically when the
// page is hidden, so it's re-requested when the page becomes visible.
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    type WakeLockSentinelLike = { release: () => Promise<void> };
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    }).wakeLock;
    if (!enabled || !wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let active = true;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      wakeLock.request('screen')
        .then(lock => {
          if (active) sentinel = lock;
          else lock.release().catch(() => undefined);
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', acquire);
      sentinel?.release().catch(() => undefined);
    };
  }, [enabled]);
}

// The fullscreen state must follow the browser: the system back gesture
// or Esc leaves fullscreen without going through our toggle.
export function useFullscreenState(onChange: (isFullscreen: boolean) => void): void {
  useEffect(() => {
    const handler = () => onChange(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, [onChange]);
}
