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
  /** Refused by the Hub. Their rows are kept, marked rejected, and never sent again. */
  rejected: { id: string; errors: string[] }[];
  /** Still in the outbox: the binding threw, or D1 did. The sweep sends them again. */
  failed: { id: string; error: string; stuck: boolean }[];
}

/** From this many failed Attempts (about an hour of trying), a row is reported stuck. */
const STUCK_AFTER_ATTEMPTS = 8;

/** `last_error` keeps this much of the thrown message. */
const MAX_ERROR_LENGTH = 500;

/** New rows wait this long before the sweep picks them up, so `sendPending` goes first. */
const FIRST_SWEEP_DELAY_MS = 60_000;

/** How many due rows one sweep sends, unless told otherwise. */
const DEFAULT_SWEEP_LIMIT = 100;

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
 * already hold, and call it inside `ctx.waitUntil` after the batch commits so
 * the request never waits on the Hub. Each event is its own `publish` call,
 * all at once. Never throws; whatever isn't acknowledged stays for the sweep.
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
  const stuck = results.length > 0 && attempts >= STUCK_AFTER_ATTEMPTS;
  const log = { id, type, attempts, error };
  if (stuck) console.error('outbox: event stuck, the Hub has not acknowledged it', log);
  else console.warn('outbox: send failed, will try again', log);
  return { id, error, stuck };
}

function message(thrown: unknown): string {
  return (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, MAX_ERROR_LENGTH);
}

function decodeDraft(body: string): EventDraft {
  return JSON.parse(body) as EventDraft;
}

/** An event the Hub refused. Fix the publisher, then delete the row by hand. */
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
