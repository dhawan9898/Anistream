// errors.ts - Narrowing helpers for values caught as `unknown`.

/** Best-effort human readable message from anything that was thrown. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** Converts a number, numeric string or big-integer-like value (GramJS BigInteger) to a number. */
export function toNumber(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'toJSNumber' in value) {
    const fn = (value as { toJSNumber?: unknown }).toJSNumber;
    if (typeof fn === 'function') return Number(fn.call(value));
  }
  return Number(value);
}
