import { describe, expect, it } from 'vitest';
import {
  HEADER,
  cursorAt,
  isEventType,
  newEventId,
  signBody,
  signingKey,
  validateDraft,
  validateEvent,
  verifyDelivery,
  type EventEnvelope,
} from '../src/events';

const NOW = Date.parse('2026-11-20T18:00:00Z');

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    specversion: '1.0',
    id: newEventId(NOW),
    type: 'platform.corrective_action.closed.v1',
    source: 'platform',
    time: '2026-11-20T17:59:00Z',
    orgid: 'org_boone_fire',
    subject: 'sr:platform:task:tsk_482',
    actor: 'usr_abc123',
    data: { status: 'closed' },
    ...overrides,
  };
}

describe('event ids', () => {
  it('are ULIDs that sort by time', () => {
    const a = newEventId(NOW);
    const b = newEventId(NOW + 1);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

describe('cursorAt', () => {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const timeOf = (id: string) =>
    [...id.slice(0, 10)].reduce((t, c) => t * 32 + ALPHABET.indexOf(c), 0);

  it('is the lowest ULID for a millisecond', () => {
    expect(cursorAt(0)).toBe('00000000000000000000000000');
    expect(cursorAt(1)).toBe('00000000010000000000000000');
    expect(cursorAt(2 ** 48 - 1)).toBe('7ZZZZZZZZZ0000000000000000');
  });

  it('round-trips to its time', () => {
    expect(timeOf(cursorAt(NOW))).toBe(NOW);
  });

  it('sorts at or below every id made in that millisecond, and above every earlier one', () => {
    for (let i = 0; i < 50; i++) {
      expect(cursorAt(NOW) <= newEventId(NOW)).toBe(true);
      expect(newEventId(NOW - 1) < cursorAt(NOW)).toBe(true);
    }
  });

  it('rounds a fractional time down', () => {
    expect(cursorAt(NOW + 0.9)).toBe(cursorAt(NOW));
  });

  it('throws on a time a ULID cannot hold', () => {
    for (const bad of [-1, 2 ** 48, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cursorAt(bad)).toThrow(RangeError);
    }
  });
});

describe('event types', () => {
  it('needs source, record type, verb and major version', () => {
    expect(isEventType('platform.corrective_action.closed.v1', 'platform')).toBe(true);
    expect(isEventType('platform.closed', 'platform')).toBe(false);
    expect(isEventType('platform.task.closed', 'platform')).toBe(false);
    expect(isEventType('quarters.alert.received.v1', 'platform')).toBe(false);
  });

  it('refuses a hyphenated record type', () => {
    expect(isEventType('platform.corrective-action.closed.v1', 'platform')).toBe(false);
  });

  it.each([
    'platform.corrective__action.closed.v1',
    'platform.task_.closed.v1',
    'platform.task.v1',
    'platform.task.sub.closed.v1',
  ])('refuses the type %s', (type) => {
    expect(isEventType(type, 'platform')).toBe(false);
  });
});

/** The problems `validateEvent` reports; empty when the event is valid. */
function errorsOf(value: unknown): string[] {
  const result = validateEvent(value);
  return result.ok ? [] : result.errors;
}

describe('validateEvent', () => {
  it('accepts a well-formed event', () => {
    expect(validateEvent(event()).ok).toBe(true);
  });

  it('reports every problem at once', () => {
    const result = validateEvent({ ...event(), id: 'nope', subject: 'loc_1', extra: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'id must be a ULID',
          'subject must be an sr: reference',
          'unknown attribute: extra',
        ]),
      );
    }
  });

  it('rejects an attribute the standard does not define, by default', () => {
    expect(validateEvent({ ...event(), traceparent: '00-abc-def-01' })).toEqual({
      ok: false,
      errors: ['unknown attribute: traceparent'],
    });
  });

  it('can ignore an unknown attribute and leave it out of the event', () => {
    const e = event();
    const result = validateEvent(
      { ...e, traceparent: '00-abc-def-01' },
      { unknownAttributes: 'ignore' },
    );
    expect(result).toEqual({ ok: true, event: e });
  });

  it('refuses a type the source does not own', () => {
    expect(validateEvent(event({ type: 'quarters.alert.received.v1' })).ok).toBe(false);
  });

  it('refuses a subject the source does not own', () => {
    const result = validateEvent(event({ subject: 'sr:rigprep:rig:rig_9' }));
    expect(result).toEqual({
      ok: false,
      errors: ['subject must be a reference owned by "platform"'],
    });
  });

  it('accepts a subject the source owns', () => {
    expect(validateEvent(event({ subject: 'sr:platform:location:loc_123' })).ok).toBe(true);
  });

  it('reports only the source error when the source is invalid', () => {
    // A valid type and a foreign subject: neither can be owned by a source that isn't an app key.
    expect(errorsOf(event({ source: 'Platform', subject: 'sr:rigprep:rig:rig_9' }))).toEqual([
      'source must be an app key',
    ]);
  });

  it('accepts a hyphenated app key and a snake_case record type', () => {
    const result = validateEvent(
      event({
        source: 'rig-prep',
        type: 'rig-prep.corrective_action.closed.v1',
        subject: 'sr:rig-prep:corrective_action:ca_1',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it.each(['rig_prep', 'rig-', 'rig--prep'])('refuses the app key %s', (source) => {
    expect(
      errorsOf(event({ source, type: `${source}.rig.checked.v1`, subject: `sr:${source}:rig:r1` })),
    ).toContain('source must be an app key');
  });

  it('refuses a subject with a hyphenated record type', () => {
    expect(errorsOf(event({ subject: 'sr:platform:corrective-action:ca_1' }))).toEqual([
      'subject must be an sr: reference',
    ]);
  });

  it('keeps data small', () => {
    expect(validateEvent(event({ data: { note: 'x'.repeat(3000) } })).ok).toBe(false);
  });
});

describe('signed delivery', () => {
  const secret = 'subscription-secret';

  async function delivery(body: string, ts: number, key?: string) {
    const headers = new Headers({
      [HEADER.timestamp]: String(ts),
      [HEADER.signature]: await signBody(key ?? (await signingKey(secret)), body, ts),
      [HEADER.attempt]: '2',
    });
    return { headers, body };
  }

  it('verifies a delivery and returns its event', async () => {
    const body = JSON.stringify(event());
    const result = await verifyDelivery(await delivery(body, NOW / 1000), { secret, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempt).toBe(2);
  });

  it('refuses a tampered body', async () => {
    const d = await delivery(JSON.stringify(event()), NOW / 1000);
    const result = await verifyDelivery(
      { ...d, body: d.body.replace('closed', 'opened') },
      {
        secret,
        now: NOW,
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a stale timestamp', async () => {
    const d = await delivery(JSON.stringify(event()), NOW / 1000 - 301);
    expect(await verifyDelivery(d, { secret, now: NOW })).toMatchObject({ reason: 'stale' });
  });

  it('refuses the wrong secret', async () => {
    const d = await delivery(JSON.stringify(event()), NOW / 1000, await signingKey('other'));
    expect(await verifyDelivery(d, { secret, now: NOW })).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('ignores an attribute it does not know and leaves it out of the event', async () => {
    const e = event();
    const body = JSON.stringify({ ...e, traceparent: '00-abc-def-01' });
    const result = await verifyDelivery(await delivery(body, NOW / 1000), { secret, now: NOW });
    expect(result).toEqual({ ok: true, event: e, attempt: 2 });
  });

  it('refuses a signed body that is not a valid event', async () => {
    const d = await delivery(JSON.stringify({ hello: 'world' }), NOW / 1000);
    expect(await verifyDelivery(d, { secret, now: NOW })).toMatchObject({ reason: 'bad_event' });
  });
});

describe('validateDraft', () => {
  const published = event();
  const draft = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(published).filter(([k]) => k !== 'specversion' && k !== 'source'),
    );

  it('fills in specversion and source from the app', () => {
    expect(validateDraft(draft(), 'platform')).toEqual({ ok: true, event: published });
  });

  it('checks ownership against the app, not the draft', () => {
    expect(validateDraft({ ...draft(), source: 'platform' }, 'quarters')).toEqual({
      ok: false,
      errors: [
        'type must start with "quarters."',
        'subject must be a reference owned by "quarters"',
      ],
    });
  });

  it('rejects an attribute the standard does not define', () => {
    expect(validateDraft({ ...draft(), priority: 'high' }, 'platform')).toEqual({
      ok: false,
      errors: ['unknown attribute: priority'],
    });
  });

  it('rejects a draft that is not an object', () => {
    expect(validateDraft(null, 'platform')).toEqual({
      ok: false,
      errors: ['event must be an object'],
    });
  });
});
