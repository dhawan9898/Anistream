// hedged.ts - "First success wins" over an ordered list of candidates.
//
// Candidates are not tried strictly one after another: a slow or hanging one
// would hold playback for its full timeout before the next was even asked.
// Instead each candidate gets `hedgeDelayMs` of head start, then the next one
// starts in parallel; one that fails (rejects or yields null) hands over
// immediately. A fast first candidate behaves exactly like a sequential walk.

export interface HedgedOptions {
  hedgeDelayMs: number;
  onError?: (err: unknown, index: number) => void;
}

export function resolveHedged<I, R>(
  items: readonly I[],
  run: (item: I, index: number) => Promise<R | null>,
  { hedgeDelayMs, onError }: HedgedOptions
): Promise<R | null> {
  return new Promise(done => {
    let next = 0;
    let pending = 0;
    let finished = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: R | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      done(result);
    };

    const launch = () => {
      if (finished || next >= items.length) return;
      const index = next++;
      pending++;
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, hedgeDelayMs);
      // run() may throw synchronously; wrap so it counts as a failed candidate.
      (async () => run(items[index], index))()
        .then(result => { if (result) finish(result); })
        .catch(err => onError?.(err, index))
        .finally(() => {
          pending--;
          if (finished) return;
          if (next < items.length) launch();
          else if (pending === 0) finish(null);
        });
    };

    if (items.length === 0) finish(null);
    else launch();
  });
}
