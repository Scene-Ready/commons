import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newEventId, type EventDraft, type EventsHub, type PublishResult } from '../../src/events';
import {
  listRejected,
  OUTBOX_SCHEMA_VERSION,
  outboxStatements,
  resendRejected,
  sendPending,
  sweepOutbox,
} from '../../src/outbox';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const MINUTE = 60_000;
const APP = 'platform';

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    id: newEventId(NOW),
    type: 'platform.task.closed.v1',
    time: '2026-11-21T12:00:00Z',
    orgid: 'org_boone_fire',
    subject: 'sr:platform:task:tsk_482',
    actor: 'usr_abc123',
    data: { status: 'closed' },
    ...overrides,
  };
}

/** A Hub that answers each publish with `answer`, and remembers what it was sent. */
function fakeHub(answer: (d: EventDraft) => PublishResult | Promise<PublishResult> = acked) {
  const sent: EventDraft[] = [];
  const hub: Pick<EventsHub, 'publish'> = {
    async publish(d) {
      sent.push(d);
      return answer(d);
    },
  };
  return { hub, sent };
}

function acked(d: EventDraft): PublishResult {
  return { ok: true, id: d.id, duplicate: false, deliveries: 1 };
}

const closeTask = (id: string) =>
  env.DB.prepare(`INSERT INTO task (id, status) VALUES (?, 'closed')`).bind(id);

/** Commits `drafts` to the outbox, as a publisher's request handler would. */
async function commit(...drafts: EventDraft[]) {
  await env.DB.batch(drafts.flatMap((d) => outboxStatements(env.DB, d, { app: APP, now: NOW })));
  return drafts;
}

/** The ids a sweep at `at` resends. The Hub acknowledges them, so they are cleared. */
async function sweptAt(at: number) {
  const { hub, sent } = fakeHub();
  await sweepOutbox(env.DB, hub, { now: at });
  return sent.map((d) => d.id);
}

const logged = { error: vi.fn(), warn: vi.fn() };

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  logged.error = vi.spyOn(console, 'error').mockImplementation(() => {});
  logged.warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM outbox_event`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, status TEXT NOT NULL)`),
    env.DB.prepare(`DELETE FROM task`),
  ]);
});

describe('outboxStatements', () => {
  it('commits the event with the Publisher’s batch', async () => {
    const event = draft();
    await env.DB.batch([
      closeTask('tsk_482'),
      ...outboxStatements(env.DB, event, { app: APP, now: NOW }),
    ]);

    const { hub, sent } = fakeHub();
    await sweepOutbox(env.DB, hub, { now: NOW + MINUTE });
    expect(sent).toEqual([event]);
  });

  it('rolls back with the Publisher’s batch', async () => {
    await env.DB.batch([closeTask('tsk_482')]);
    const failing = env.DB.batch([
      ...outboxStatements(env.DB, draft(), { app: APP, now: NOW }),
      closeTask('tsk_482'), // primary key conflict
    ]);
    await expect(failing).rejects.toThrow();

    const { hub, sent } = fakeHub();
    await sweepOutbox(env.DB, hub, { now: NOW + MINUTE });
    expect(sent).toEqual([]);
  });

  /** env.DB, counting the statements prepared through it. */
  function countingDb() {
    const db = { prepared: 0, prepare: (q: string) => (db.prepared++, env.DB.prepare(q)) };
    return db;
  }

  it('throws on an invalid draft before building any statement', () => {
    const db = countingDb();
    expect(() =>
      outboxStatements(db, draft({ subject: 'sr:quarters:room:rm_1' }), { app: APP, now: NOW }),
    ).toThrow('invalid event: subject must be a reference owned by "platform"');
    expect(db.prepared).toBe(0);
  });

  it('throws on a draft with an attribute the standard does not define', () => {
    const db = countingDb();
    const extra = { ...draft(), priority: 'high' } as EventDraft;
    expect(() => outboxStatements(db, extra, { app: APP, now: NOW })).toThrow(
      'invalid event: unknown attribute: priority',
    );
    expect(db.prepared).toBe(0);
  });
});

describe('sendPending', () => {
  it('deletes the row when the Hub acknowledges the event', async () => {
    const [event] = await commit(draft());
    const { hub, sent } = fakeHub();

    expect(await sendPending(env.DB, hub, [event], { now: NOW })).toEqual({
      sent: [event.id],
      duplicate: [],
      rejected: [],
      failed: [],
    });
    expect(sent).toEqual([event]);
    expect(await sweptAt(NOW + 10 * MINUTE)).toEqual([]);
  });

  it('deletes the row when the Hub already has the event', async () => {
    const [event] = await commit(draft());
    const { hub } = fakeHub((d) => ({ ok: true, id: d.id, duplicate: true, deliveries: 0 }));

    expect(await sendPending(env.DB, hub, [event], { now: NOW })).toMatchObject({
      sent: [event.id],
      duplicate: [event.id],
    });
    expect(await sweptAt(NOW + 10 * MINUTE)).toEqual([]);
  });
});

describe('a rejected event', () => {
  const errors = ['data must be at most 2048 bytes'];
  const refuse = (): PublishResult => ({ ok: false, errors });

  it('is kept, marked rejected and logged at error level', async () => {
    const [event] = await commit(draft());

    expect(await sendPending(env.DB, fakeHub(refuse).hub, [event], { now: NOW })).toEqual({
      sent: [],
      duplicate: [],
      rejected: [{ id: event.id, errors }],
      failed: [],
    });
    expect(await listRejected(env.DB)).toEqual([
      { id: event.id, draft: event, createdAt: NOW, rejectedAt: NOW, attempts: 0, errors },
    ]);
    expect(logged.error).toHaveBeenCalledWith(
      'outbox: event rejected by the Hub',
      expect.objectContaining({ id: event.id, errors }),
    );
  });

  it('is never retried by the sweep', async () => {
    const [rejected, pending] = await commit(draft(), draft());
    await sendPending(env.DB, fakeHub(refuse).hub, [rejected], { now: NOW });

    expect(await sweptAt(NOW + 10 * MINUTE)).toEqual([pending.id]);
    expect(await listRejected(env.DB)).toMatchObject([{ id: rejected.id }]);
  });

  it('is sent by the next sweep once resent', async () => {
    const [event] = await commit(draft());
    await sendPending(env.DB, fakeHub(refuse).hub, [event], { now: NOW });
    const later = NOW + 60 * MINUTE;

    expect(await resendRejected(env.DB, event.id, { now: later })).toBe(true);
    expect(await listRejected(env.DB)).toEqual([]);
    expect(await sweptAt(later)).toEqual([event.id]);
  });

  it('can’t be resent by an unknown or unrejected id', async () => {
    const [rejected, pending] = await commit(draft(), draft());
    await sendPending(env.DB, fakeHub(refuse).hub, [rejected], { now: NOW });

    expect(await resendRejected(env.DB, newEventId(NOW), { now: NOW })).toBe(false);
    expect(await resendRejected(env.DB, pending.id, { now: NOW })).toBe(false);
    // The pending row is still due a minute after commit, not now.
    expect(await sweptAt(NOW)).toEqual([]);
    expect(await listRejected(env.DB)).toMatchObject([{ id: rejected.id, errors }]);
  });
});

describe('an event the Hub does not acknowledge', () => {
  const down = () => {
    throw new Error('Network connection lost.');
  };

  it('stays pending, with attempts and next_attempt_at advanced', async () => {
    const [event] = await commit(draft());

    expect(await sendPending(env.DB, fakeHub(down).hub, [event], { now: NOW })).toEqual({
      sent: [],
      duplicate: [],
      rejected: [],
      failed: [{ id: event.id, error: 'Network connection lost.', stuck: false }],
    });
    const row = await env.DB.prepare(
      `SELECT attempts, next_attempt_at, last_error FROM outbox_event WHERE id = ?`,
    )
      .bind(event.id)
      .first<{ attempts: number; next_attempt_at: number; last_error: string }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('Network connection lost.');
    // 30 seconds after the first failure, ±20%.
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(NOW + 24_000);
    expect(row?.next_attempt_at).toBeLessThanOrEqual(NOW + 36_000);
    expect(logged.warn).toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();

    expect(await sweptAt(NOW + 23_000)).toEqual([]);
    expect(await sweptAt(NOW + 37_000)).toEqual([event.id]);
  });

  it('warns when sent without a committed row', async () => {
    const uncommitted = draft();

    expect(await sendPending(env.DB, fakeHub(down).hub, [uncommitted], { now: NOW })).toEqual({
      sent: [],
      duplicate: [],
      rejected: [],
      failed: [{ id: uncommitted.id, error: 'Network connection lost.', stuck: false }],
    });
    expect(logged.warn).toHaveBeenCalledWith(
      'outbox: no outbox row for this event; was the batch committed?',
      expect.objectContaining({ id: uncommitted.id, type: uncommitted.type }),
    );
  });

  it('keeps one failure from stopping the others', async () => {
    const [failing, fine] = await commit(draft(), draft());
    const { hub } = fakeHub((d) => (d.id === failing.id ? down() : acked(d)));

    expect(await sendPending(env.DB, hub, [failing, fine], { now: NOW })).toMatchObject({
      sent: [fine.id],
      failed: [{ id: failing.id }],
    });
  });

  it('keeps a D1 error on one row from losing the others', async () => {
    const [unlucky, fine] = await commit(draft(), draft());
    // env.DB, except that clearing `unlucky`'s row fails.
    const db = {
      prepare: (q: string) => {
        const statement = env.DB.prepare(q);
        return {
          bind: (...values: unknown[]) =>
            values.includes(unlucky.id) && q.startsWith('DELETE')
              ? { ...statement.bind(...values), run: () => Promise.reject(new Error('D1_ERROR')) }
              : statement.bind(...values),
        };
      },
    };

    expect(await sendPending(db, fakeHub().hub, [unlucky, fine], { now: NOW })).toMatchObject({
      sent: [fine.id],
      failed: [{ id: unlucky.id, error: 'D1_ERROR', stuck: false }],
    });
  });
});

describe('sweepOutbox', () => {
  const commitAt = async (now: number, d = draft()) => {
    await env.DB.batch(outboxStatements(env.DB, d, { app: APP, now }));
    return d;
  };

  it('resends only rows that are due', async () => {
    const due = await commitAt(NOW);
    await commitAt(NOW + 1);

    const { hub, sent } = fakeHub();
    expect(await sweepOutbox(env.DB, hub, { now: NOW + MINUTE })).toMatchObject({
      sent: [due.id],
    });
    expect(sent.map((d) => d.id)).toEqual([due.id]);
  });

  it('resends at most `limit` rows, oldest first', async () => {
    const first = await commitAt(NOW, draft({ id: newEventId(NOW) }));
    const second = await commitAt(NOW + 1, draft({ id: newEventId(NOW + 1) }));
    await commitAt(NOW + 2, draft({ id: newEventId(NOW + 2) }));

    const { hub, sent } = fakeHub();
    await sweepOutbox(env.DB, hub, { now: NOW + 10 * MINUTE, limit: 2 });
    expect(sent.map((d) => d.id)).toEqual([first.id, second.id]);
  });

  it('reports a row stuck from its eighth failed attempt', async () => {
    const seventh = await commitAt(NOW);
    const eighth = await commitAt(NOW);
    const setAttempts = (id: string, attempts: number) =>
      env.DB.prepare(`UPDATE outbox_event SET attempts = ? WHERE id = ?`).bind(attempts, id);
    await env.DB.batch([setAttempts(seventh.id, 6), setAttempts(eighth.id, 7)]);

    const { hub } = fakeHub(() => {
      throw new Error('Network connection lost.');
    });
    const result = await sweepOutbox(env.DB, hub, { now: NOW + MINUTE });
    expect(result.failed).toHaveLength(2);
    expect(result.failed).toContainEqual({
      id: seventh.id,
      error: 'Network connection lost.',
      stuck: false,
    });
    expect(result.failed).toContainEqual({
      id: eighth.id,
      error: 'Network connection lost.',
      stuck: true,
    });
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(logged.error).toHaveBeenCalledWith(
      'outbox: event stuck, the Hub has not acknowledged it',
      expect.objectContaining({ id: eighth.id, attempts: 8 }),
    );
  });
});

describe('OUTBOX_SCHEMA_VERSION', () => {
  it('is the number of the newest shipped migration', () => {
    const newest = env.TEST_MIGRATIONS.map((m) => m.name)
      .sort()
      .at(-1);
    expect(newest).toMatch(new RegExp(`^${String(OUTBOX_SCHEMA_VERSION).padStart(4, '0')}_`));
  });
});
