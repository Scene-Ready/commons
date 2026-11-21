import { parseRef } from '../refs';

/**
 * The event envelope every Scene Ready app publishes and receives: CloudEvents
 * 1.0 attribute names plus `orgid` and `actor`. Events are hints: `subject`
 * names the record that changed, and receivers refetch it from its owner.
 * See docs/contracts/event-standard.md.
 */
export interface EventEnvelope<Data extends Record<string, unknown> = Record<string, unknown>> {
  specversion: '1.0';
  /** ULID, set by the publisher when it writes its outbox row; stable across retries. */
  id: string;
  /** `<source>.<entity>.<past-tense verb>.v<major>`, such as `platform.corrective_action.closed.v1`. */
  type: string;
  /** The publishing app's key. The events Worker sets it from the caller's binding. */
  source: string;
  /** When the change happened, RFC 3339 in UTC. */
  time: string;
  /** The auth organization the event belongs to. */
  orgid: string;
  /** The cross-app reference of the record that changed. */
  subject: string;
  /** The auth user who caused the change, when there is one. */
  actor?: string;
  /** Small, non-sensitive hints only, such as a new status. Never personal data. */
  data?: Data;
}

/** What a publisher supplies; the events Worker fills in `specversion` and `source`. */
export type EventDraft<Data extends Record<string, unknown> = Record<string, unknown>> = Omit<
  EventEnvelope<Data>,
  'specversion' | 'source'
>;

/** Hard cap on the serialized `data`, to keep events as hints. */
export const MAX_DATA_BYTES = 2048;

const APP = /^[a-z][a-z0-9-]*$/;
const TYPE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_]*)+\.v[1-9][0-9]*$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ORG = /^[A-Za-z0-9._~-]{1,128}$/;

/** True when `type` is well formed and owned by `source`. */
export function isEventType(type: string, source?: string): boolean {
  if (!TYPE.test(type)) return false;
  return source === undefined || type.startsWith(`${source}.`);
}

export type Validation = { ok: true; event: EventEnvelope } | { ok: false; errors: string[] };

/**
 * Checks an envelope against the standard. Returns every problem found, so a
 * publisher sees them all at once.
 */
export function validateEvent(value: unknown): Validation {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['event must be an object'] };
  }
  const e = value as Record<string, unknown>;
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined);

  if (e.specversion !== '1.0') errors.push('specversion must be "1.0"');
  const id = str('id');
  if (!id || !ULID.test(id)) errors.push('id must be a ULID');
  const source = str('source');
  if (!source || !APP.test(source)) errors.push('source must be an app key');
  const type = str('type');
  if (!type || !isEventType(type)) {
    errors.push('type must be <source>.<entity>.<verb>.v<major>');
  } else if (source && !type.startsWith(`${source}.`)) {
    errors.push(`type must start with "${source}."`);
  }
  const time = str('time');
  if (!time || Number.isNaN(Date.parse(time)) || !time.endsWith('Z')) {
    errors.push('time must be an RFC 3339 UTC timestamp');
  }
  const orgid = str('orgid');
  if (!orgid || !ORG.test(orgid)) errors.push('orgid must be an auth organization id');
  const subject = str('subject');
  const subjectRef = subject ? parseRef(subject) : null;
  if (!subjectRef) {
    errors.push('subject must be an sr: reference');
  } else if (source && APP.test(source) && subjectRef.app !== source) {
    errors.push(`subject must be a reference owned by "${source}"`);
  }
  if (e.actor !== undefined && (typeof e.actor !== 'string' || e.actor.length === 0)) {
    errors.push('actor must be a user id when present');
  }
  if (e.data !== undefined) {
    if (typeof e.data !== 'object' || e.data === null || Array.isArray(e.data)) {
      errors.push('data must be an object when present');
    } else if (new TextEncoder().encode(JSON.stringify(e.data)).length > MAX_DATA_BYTES) {
      errors.push(`data must be at most ${MAX_DATA_BYTES} bytes`);
    }
  }
  const known = new Set([
    'specversion',
    'id',
    'type',
    'source',
    'time',
    'orgid',
    'subject',
    'actor',
    'data',
  ]);
  for (const k of Object.keys(e)) if (!known.has(k)) errors.push(`unknown field: ${k}`);

  return errors.length ? { ok: false, errors } : { ok: true, event: e as unknown as EventEnvelope };
}
