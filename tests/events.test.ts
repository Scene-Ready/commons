import { describe, expect, it } from 'vitest';
import {
  HEADER,
  isEventType,
  newEventId,
  signBody,
  signingKey,
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
          'unknown field: extra',
        ]),
      );
    }
  });

  it('rejects an attribute the standard does not define, by default', () => {
    expect(validateEvent({ ...event(), traceparent: '00-abc-def-01' })).toEqual({
      ok: false,
      errors: ['unknown field: traceparent'],
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
    const result = validateEvent(
      event({
        source: 'Platform',
        type: 'Platform.task.closed.v1',
        subject: 'sr:rigprep:rig:rig_9',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('source must be an app key');
      expect(result.errors.some((m) => m.startsWith('subject'))).toBe(false);
    }
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

  it('refuses an underscored app key', () => {
    const result = validateEvent(
      event({
        source: 'rig_prep',
        type: 'rig_prep.rig.checked.v1',
        subject: 'sr:rig_prep:rig:rig_9',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('source must be an app key');
  });

  it.each(['rig-', 'rig--prep'])('refuses the app key %s', (source) => {
    const result = validateEvent(event({ source, type: `${source}.rig.checked.v1` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('source must be an app key');
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
