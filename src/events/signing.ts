import { validateEvent, type EventEnvelope } from './envelope';

/**
 * Signed delivery, the same scheme as auth's webhooks: an HMAC-SHA256 over
 * `"v1:" + timestamp + ":" + raw body`, keyed by the text of
 * base64url(SHA-256(secret)). The events Worker stores only that derived key.
 */

export const HEADER = {
  eventId: 'X-SR-Event-Id',
  eventType: 'X-SR-Event-Type',
  deliveryId: 'X-SR-Delivery-Id',
  attempt: 'X-SR-Attempt',
  timestamp: 'X-SR-Timestamp',
  signature: 'X-SR-Signature',
} as const;

/** Deliveries older or newer than this are refused as replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The key the events Worker stores and signs with, derived from a subscription secret. */
export async function signingKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return base64url(new Uint8Array(digest));
}

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `X-SR-Signature` value for a body, signed with a derived key at `timestamp` (Unix seconds). */
export async function signBody(key: string, body: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmac(key, `v1:${timestamp}:${body}`)}`;
}

export type VerifyResult =
  | { ok: true; event: EventEnvelope; attempt: number }
  | {
      ok: false;
      reason: 'missing_headers' | 'stale' | 'bad_signature' | 'bad_event';
      detail?: string[];
    };

/**
 * Verifies a delivery and parses its event. Pass the raw body text, read once,
 * before any JSON parsing: re-serialized JSON will not verify.
 */
export async function verifyDelivery(
  input: { headers: Headers; body: string },
  options: { secret: string; toleranceSeconds?: number; now?: number },
): Promise<VerifyResult> {
  const ts = input.headers.get(HEADER.timestamp);
  const sig = input.headers.get(HEADER.signature);
  if (!ts || !sig) return { ok: false, reason: 'missing_headers' };

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > tolerance) {
    return { ok: false, reason: 'stale' };
  }

  const parts = Object.fromEntries(
    sig.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  if (parts.t !== ts || typeof parts.v1 !== 'string') return { ok: false, reason: 'bad_signature' };

  const key = await signingKey(options.secret);
  const expected = await hmac(key, `v1:${ts}:${input.body}`);
  if (!timingSafeEqual(expected, parts.v1)) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return { ok: false, reason: 'bad_event', detail: ['body is not JSON'] };
  }
  const checked = validateEvent(parsed);
  if (!checked.ok) return { ok: false, reason: 'bad_event', detail: checked.errors };

  const attempt = Number(input.headers.get(HEADER.attempt) ?? '1');
  return { ok: true, event: checked.event, attempt: Number.isFinite(attempt) ? attempt : 1 };
}
