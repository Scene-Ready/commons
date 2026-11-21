const BASE_MS = 30_000;
const CAP_MS = 60 * 60_000;
const SPREAD = 0.2;

/**
 * When to send an unacknowledged event again, after its `attempts`th failed
 * Attempt: 30 seconds after the first, doubling each time, capped at one hour,
 * then spread ±20% so Attempts after an outage don't arrive together. The
 * eighth Attempt comes about an hour after the first. `jitter` is in [0, 1];
 * 0.5 means no spread.
 */
export function nextAttemptAt(
  attempts: number,
  now: number,
  jitter: number = Math.random(),
): number {
  const delay = Math.min(BASE_MS * 2 ** Math.max(attempts - 1, 0), CAP_MS);
  return now + Math.round(delay * (1 + SPREAD * (2 * jitter - 1)));
}
