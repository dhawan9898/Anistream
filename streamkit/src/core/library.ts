// library.ts - Building blocks for the watch-history / My List services that
// both apps implement (each keeps its own data model and storage backend).

// ------------------------------------------------------------ serial queue

/**
 * Runs async tasks one at a time. Read-modify-write updates of the same
 * storage key must not interleave, or a slower write can clobber a newer one
 * (progress ticks arrive every second while the user may also bookmark or
 * remove items). A failed task never blocks the ones queued behind it.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

// ---------------------------------------------------------- change notifier

export interface ChangeNotifier {
  subscribe(listener: () => void): () => void;
  /** Notifies listeners; with force=false the call is held back while playback is active. */
  notify(force?: boolean): void;
  /**
   * While an episode plays, progress is saved every few seconds. Screens
   * underneath the player must not re-render for each save, so notifications
   * are held back and delivered once playback is over.
   */
  setPlaybackActive(active: boolean): void;
}

export function createChangeNotifier(onListenerError?: (err: unknown) => void): ChangeNotifier {
  const listeners = new Set<() => void>();
  let playbackActive = false;
  let pending = false;

  const deliver = () => {
    listeners.forEach(listener => {
      try { listener(); } catch (err) { onListenerError?.(err); }
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify(force = true) {
      if (playbackActive && !force) { pending = true; return; }
      deliver();
    },
    setPlaybackActive(active) {
      playbackActive = active;
      if (!active && pending) { pending = false; deliver(); }
    }
  };
}

// --------------------------------------------------------------- JSON lists

/**
 * Parses a stored JSON array and keeps only entries that pass `isValid`.
 * Entries with the wrong shape are dropped one by one rather than crashing
 * whichever screen renders them; a corrupt value (e.g. an interrupted write)
 * yields an empty list instead of throwing on every read.
 */
export function parseValidatedList<T>(raw: string | null, isValid: (item: unknown) => boolean): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter(isValid) as T[]) : [];
  } catch {
    return [];
  }
}
