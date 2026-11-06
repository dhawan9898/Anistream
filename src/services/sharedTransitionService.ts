// sharedTransitionService.ts - Coordinates shared element transitions between
// poster cards and the anime detail view for seamless Apple-style pop & expand animations.
import type { AnimeItem } from '../providers/aniCliCore';

export interface CardRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SharedTransitionState {
  active: boolean;
  anime: AnimeItem | null;
  originRect: CardRect | null;
  phase: 'idle' | 'expanding' | 'settled' | 'closing';
}

let currentState: SharedTransitionState = {
  active: false,
  anime: null,
  originRect: null,
  phase: 'idle'
};

const listeners = new Set<(state: SharedTransitionState) => void>();

const notify = () => {
  listeners.forEach(fn => fn(currentState));
};

export const subscribeSharedTransition = (fn: (state: SharedTransitionState) => void): (() => void) => {
  listeners.add(fn);
  fn(currentState);
  return () => {
    listeners.delete(fn);
  };
};

export const getSharedTransitionState = (): SharedTransitionState => currentState;

export const startSharedTransition = (
  rect: DOMRect | CardRect,
  anime: AnimeItem
): void => {
  // Capture snapshot of the clicked card's exact position on screen
  const originRect: CardRect = {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };

  currentState = {
    active: true,
    anime,
    originRect,
    phase: 'expanding'
  };
  // CSS keys off this so the title page only fades in while the poster flies.
  document.documentElement.dataset.sharedTransition = '1';
  notify();
};

export const finishSharedTransition = (): void => {
  if (!currentState.active) return;
  currentState = {
    ...currentState,
    phase: 'settled',
    active: false
  };
  delete document.documentElement.dataset.sharedTransition;
  notify();
};

export const resetSharedTransition = (): void => {
  currentState = {
    active: false,
    anime: null,
    originRect: null,
    phase: 'idle'
  };
  delete document.documentElement.dataset.sharedTransition;
  notify();
};
