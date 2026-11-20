const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A new ULID: 48 bits of milliseconds then 80 random bits, Crockford base32.
 * Sorts by creation time, so event logs and outboxes read in order.
 */
export function newEventId(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += ALPHABET.charAt(b % 32);
  return time + rand;
}
