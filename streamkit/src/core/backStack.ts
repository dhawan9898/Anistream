// backStack.ts - Lets transient layers (modals, pickers) claim the Android
// back gesture before the app navigates. The most recently opened layer is
// asked first; App falls back to screen navigation when none is open.
import { useEffect, useRef } from 'react';

type BackHandler = () => void;

const stack: BackHandler[] = [];

// True when an open layer consumed the back press.
export function handleLayerBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}

export function useBackHandler(enabled: boolean, handler: BackHandler): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const entry: BackHandler = () => handlerRef.current();
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [enabled]);
}
