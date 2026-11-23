import { validateDraft, type EventDraft, type EventsHub, type PublishResult } from '../events';
import { nextAttemptAt } from './backoff';

/**
 * The part of D1's prepared statement the outbox calls. Structural, so commons
 * needs no Workers types: `env.DB.prepare(...)` satisfies it.
 */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

/** The part of `D1Database` the outbox calls. Pass `env.DB`. */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

/** All the outbox needs of the Hub. Pass `env.EVENTS_HUB`. */
export type HubPublish = Pick<EventsHub, 'publish'>;

/** What one send or sweep did, event by event. */
export interface SendResult {
  /** Acknowledged by the Hub; their rows are deleted. */
  sent: string[];
  /** Acknowledged as already published (a subset of `sent`). */
  duplicate: string[];
  /** Refused by the Hub. Kept and marked rejected; not sent again unless `resendRejected`. */
  rejected: { id: string; errors: string[] }[];
  /**
   * The binding threw, or D1 did. The sweep sends them again, unless the event
   * had no outbox row (logged as a warning): then nothing will.
   */
  failed: { id: string; error: string; stuck: boolean }[];
}

/**
 * From this many failed Attempts (about an hour of trying), a row is reported
 * stuck: the sweep logs it at error level, and `listStuck` lists it.
 */
export const STUCK_AFTER_ATTEMPTS = 8;

/** `last_error` keeps this much of the thrown message. */
const MAX_ERROR_LENGTH = 500;

/** New rows wait this long before the sweep picks them up, so `sendPending` goes first. */
const FIRST_SWEEP_DELAY_MS = 60_000;

/** How many due rows one sweep sends, unless told otherwise. */
const DEFAULT_SWEEP_LIMIT = 100;

/** How many stuck rows `listStuck` returns, unless told otherwise. */
const DEFAULT_STUCK_LIMIT = 100;

/**
 * The statements that write `draft` to the outbox. Put them in the same
 * `db.batch` as the change the event describes, so the two commit or roll back
 * together. Set `draft.id` with `newEventId()` first; every Attempt carries it.
 * The statements come back typed as your D1's own, ready for `db.batch`.
 *
 * Throws when the draft would not pass the Hub's check as `app`, so a bad event
 * never commits. `app` is used only for that check: the Hub takes `source` from
 * the binding.
 */
export function outboxStatements<Statement>(
  db: { prepare(query: string): { bind(...values: unknown[]): Statement } },
  draft: EventDraft,
  options: { app: string; now?: number },
): Statement[] {
  const checked = validateDraft(draft, options.app);
  if (!checked.ok) throw new Error(`invalid event: ${checked.errors.join('; ')}`);
  // Stored as the draft: the Hub sets specversion and source on receipt.
  const { id, type, time, orgid, subject, actor, data } = checked.event;
  const body: EventDraft = { id, type, time, orgid, subject, actor, data };
  const now = options.now ?? Date.now();
  return [
    db
      .prepare(
        `INSERT INTO outbox_event (id, body, created_at, next_attempt_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(id, JSON.stringify(body), now, now + FIRST_SWEEP_DELAY_MS),
  ];
}

/**
 * Sends events just committed with `outboxStatements`. Pass the drafts you
 * already hold, and call it inside `ctx.waitUntil` once `await db.batch(...)`
 * has resolved, never in a `finally` or a `catch`: it doesn't read the rows
 * back, so it would publish an event whose change rolled back. Each event is
 * its own `publish` call, all at once. Never throws; whatever isn't
 * acknowledged stays for the sweep.
 */
export async function sendPending(
  db: D1DatabaseLike,
  hub: HubPublish,
  drafts: EventDraft[],
  options: { now?: number } = {},
): Promise<SendResult> {
  const pending = drafts.map((draft) => ({ draft, attempts: 0 }));
  return send(db, hub, pending, options.now ?? Date.now());
}

/**
 * Sends again the events the Hub has not acknowledged and that are due, oldest
 * first. Run it from the app's cron at least every few minutes. Throws only if
 * D1 can't read the outbox.
 */
export async function sweepOutbox(
  db: D1DatabaseLike,
  hub: HubPublish,
  options: { now?: number; limit?: number } = {},
): Promise<SendResult> {
  const now = options.now ?? Date.now();
  const { results } = await db
    .prepare(
      `SELECT body, attempts FROM outbox_event
       WHERE rejected_at IS NULL AND next_attempt_at <= ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(now, options.limit ?? DEFAULT_SWEEP_LIMIT)
    .all<{ body: string; attempts: number }>();
  const pending = results.map((r) => ({ draft: decodeDraft(r.body), attempts: r.attempts }));
  return send(db, hub, pending, now);
}

/** An outbox row on its way to the Hub: the draft and its failed Attempts so far. */
interface Pending {
  draft: EventDraft;
  attempts: number;
}

async function send(
  db: D1DatabaseLike,
  hub: HubPublish,
  pending: Pending[],
  now: number,
): Promise<SendResult> {
  const result: SendResult = { sent: [], duplicate: [], rejected: [], failed: [] };
  await Promise.all(
    pending.map(async (row) => {
      const { id } = row.draft;
      try {
        let answer: PublishResult;
        try {
          answer = await hub.publish(row.draft);
        } catch (thrown) {
          result.failed.push(await recordFailure(db, row, message(thrown), now));
          return;
        }
        if (answer.ok) {
          await db.prepare(`DELETE FROM outbox_event WHERE id = ?`).bind(id).run();
          result.sent.push(id);
          if (answer.duplicate) result.duplicate.push(id);
        } else {
          await recordRejection(db, row.draft, answer.errors, now);
          result.rejected.push({ id, errors: answer.errors });
        }
      } catch (thrown) {
        // D1 failed after the Hub answered. The row is left as it was, so the
        // sweep sends it again and the Hub's duplicate ack settles it.
        const error = message(thrown);
        console.warn('outbox: could not record the Hub’s answer', { id, error });
        result.failed.push({ id, error, stuck: false });
      }
    }),
  );
  return result;
}

async function recordRejection(
  db: D1DatabaseLike,
  draft: EventDraft,
  errors: string[],
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE outbox_event SET rejected_at = COALESCE(rejected_at, ?), errors = ? WHERE id = ?`,
    )
    .bind(now, JSON.stringify(errors), draft.id)
    .run();
  console.error('outbox: event rejected by the Hub', { id: draft.id, type: draft.type, errors });
}

/**
 * Counts a failed Attempt and schedules the next, in one statement. It applies
 * only if no other send or sweep has touched the row since it was read; if one
 * has, that one's record stands.
 */
async function recordFailure(
  db: D1DatabaseLike,
  row: Pending,
  error: string,
  now: number,
): Promise<SendResult['failed'][number]> {
  const { id, type } = row.draft;
  const attempts = row.attempts + 1;
  const { results } = await db
    .prepare(
      `UPDATE outbox_event SET attempts = ?, last_error = ?, next_attempt_at = ?
       WHERE id = ? AND attempts = ? AND rejected_at IS NULL RETURNING id`,
    )
    .bind(attempts, error, nextAttemptAt(attempts, now), id, row.attempts)
    .all();
  const recorded = results.length > 0;
  const stuck = recorded && attempts >= STUCK_AFTER_ATTEMPTS;
  const log = { id, type, attempts, error };
  // A row that has never failed and is gone usually means `sendPending` was
  // called for a batch that never committed, so nothing will send it again.
  // (A concurrent ack or rejection can also remove it; the warning says "was".)
  if (!recorded && row.attempts === 0) {
    console.warn('outbox: no outbox row for this event; was the batch committed?', log);
  } else if (stuck) {
    console.error('outbox: event stuck, the Hub has not acknowledged it', log);
  } else {
    console.warn('outbox: send failed, will try again', log);
  }
  return { id, error, stuck };
}

function message(thrown: unknown): string {
  return (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, MAX_ERROR_LENGTH);
}

function decodeDraft(body: string): EventDraft {
  return JSON.parse(body) as EventDraft;
}

/**
 * Puts a rejected event back in line: clears its rejection and makes it due at
 * `now`, so the next sweep sends it. Call it once the cause is fixed outside
 * the publisher (the Hub upgraded, the binding corrected); nothing calls it
 * automatically. Returns false, changing nothing, if no rejected row has `id`.
 * The row keeps its count of failed Attempts, so one that failed often before
 * its rejection is reported stuck sooner.
 */
export async function resendRejected(
  db: D1DatabaseLike,
  id: string,
  options: { now?: number } = {},
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `UPDATE outbox_event SET rejected_at = NULL, errors = NULL, next_attempt_at = ?
       WHERE id = ? AND rejected_at IS NOT NULL RETURNING id`,
    )
    .bind(options.now ?? Date.now(), id)
    .all();
  return results.length > 0;
}

/** An event the Hub refused. Fix the cause, then delete the row or `resendRejected` it. */
export interface RejectedEvent {
  id: string;
  draft: EventDraft;
  createdAt: number;
  rejectedAt: number;
  attempts: number;
  errors: string[];
}

/** Every rejected row in this database's outbox, oldest rejection first. */
export async function listRejected(db: D1DatabaseLike): Promise<RejectedEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, body, created_at, rejected_at, attempts, errors FROM outbox_event
       WHERE rejected_at IS NOT NULL ORDER BY rejected_at, id`,
    )
    .all<{
      id: string;
      body: string;
      created_at: number;
      rejected_at: number;
      attempts: number;
      errors: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    draft: decodeDraft(r.body),
    createdAt: r.created_at,
    rejectedAt: r.rejected_at,
    attempts: r.attempts,
    errors: r.errors ? (JSON.parse(r.errors) as string[]) : [],
  }));
}

/** An event the Hub has not acknowledged after `STUCK_AFTER_ATTEMPTS` or more Attempts. */
export interface StuckEvent {
  id: string;
  draft: EventDraft;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** When the sweep next sends it. */
  nextAttemptAt: number;
}

/**
 * The rows the outbox reports stuck, oldest first, at most `limit` (default
 * 100). The sweep keeps sending them; nothing needs doing once the Hub is
 * reachable again.
 *
 * A row that is due at `now` is left out: a failed Attempt always schedules the
 * next in the future, so a due row hasn't failed since it was last scheduled.
 * That keeps out a row `resendRejected` just made due, which keeps its old
 * count, until the sweep has tried it. It also leaves out, until the sweep
 * runs, a stuck row whose next Attempt has come round.
 */
export async function listStuck(
  db: D1DatabaseLike,
  options: { now?: number; limit?: number } = {},
): Promise<StuckEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, body, created_at, attempts, last_error, next_attempt_at FROM outbox_event
       WHERE rejected_at IS NULL AND attempts >= ? AND next_attempt_at > ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(STUCK_AFTER_ATTEMPTS, options.now ?? Date.now(), options.limit ?? DEFAULT_STUCK_LIMIT)
    .all<{
      id: string;
      body: string;
      created_at: number;
      attempts: number;
      last_error: string | null;
      next_attempt_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    draft: decodeDraft(r.body),
    createdAt: r.created_at,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
  }));
}
