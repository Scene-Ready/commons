const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID's first 10 characters: `ms` in Crockford base32. */
function encodeTime(ms: number): string {
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  return time;
}

/**
 * A new ULID: 48 bits of milliseconds then 80 random bits, Crockford base32.
 * Sorts by creation time, so event logs and outboxes read in order.
 */
export function newEventId(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += ALPHABET.charAt(b % 32);
  return encodeTime(now) + rand;
}

/**
 * The lowest ULID for millisecond `ms`, as a Catch-up cursor: it sorts below
 * every event id made at `ms` or later and above every earlier one. To recover
 * after missed deliveries, catch up from `cursorAt` a time you know you were
 * healthy and dedupe on `id`. Throws a `RangeError` for a time a ULID can't
 * hold (negative, past 2^48 - 1, or not finite).
 */
export function cursorAt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms >= 2 ** 48) {
    throw new RangeError(`cursorAt: ${ms} is not a time a ULID can hold`);
  }
  return encodeTime(Math.floor(ms)) + '0'.repeat(16);
}
