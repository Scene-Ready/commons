import { describe, expect, it } from 'vitest';
import {
  followStep,
  type FollowInput,
  type FollowRecord,
  type FollowStep,
} from '../src/oidc/index';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

const due: FollowInput = { type: 'due', trigger: 'focus' };
const unavailable: FollowInput = { type: 'check_failed', reason: 'unavailable' };
const checked = (sessionOrgId: string | null, activeOrgId: string | null): FollowInput => ({
  type: 'checked',
  sessionOrgId,
  activeOrgId,
});

/** Runs inputs in order from `record`, each at its own time. */
function run(record: FollowRecord | null, steps: [FollowInput, number][]): FollowStep[] {
  const out: FollowStep[] = [];
  for (const [input, now] of steps) {
    const step = followStep(record, input, now);
    out.push(step);
    record = step.record;
  }
  return out;
}

describe('followStep: the 5-minute cap', () => {
  it('checks on a first load', () => {
    expect(followStep(null, { type: 'due', trigger: 'load' }, T0).action).toEqual({
      type: 'check',
    });
  });

  it('skips a load or focus within 5 minutes of the last check, and checks after', () => {
    const { record } = followStep(null, checked('org_a', 'org_a'), T0);
    expect(followStep(record, { type: 'due', trigger: 'load' }, T0 + 4 * MIN).action.type).toBe(
      'skip',
    );
    expect(followStep(record, due, T0 + 5 * MIN - 1).action.type).toBe('skip');
    expect(followStep(record, due, T0 + 5 * MIN).action.type).toBe('check');
  });

  it('does not change the record', () => {
    const { record } = followStep(null, checked('org_a', 'org_a'), T0);
    expect(followStep(record, due, T0 + MIN).record).toBe(record);
  });

  it('checks when the last check is in the future (clock skew)', () => {
    const record: FollowRecord = { lastCheckedAt: T0 + 10 * MIN, refused: null, failures: null };
    expect(followStep(record, due, T0).action.type).toBe('check');
  });
});

describe('followStep: a successful check', () => {
  it('stays when the session is in the Active Org', () => {
    const step = followStep(null, checked('org_a', 'org_a'), T0);
    expect(step.action).toEqual({ type: 'stay' });
    expect(step.record).toEqual({ lastCheckedAt: T0, refused: null, failures: null });
  });

  it('follows when the Active Org differs', () => {
    expect(followStep(null, checked('org_a', 'org_b'), T0).action).toEqual({
      type: 'follow',
      orgId: 'org_b',
    });
  });

  it('follows from a session with no org into a new Active Org', () => {
    expect(followStep(null, checked(null, 'org_b'), T0).action).toEqual({
      type: 'follow',
      orgId: 'org_b',
    });
  });

  it.each([['org_a'], [null]])('is not provisioned with no Active Org (session %s)', (org) => {
    expect(followStep(null, checked(org, null), T0).action).toEqual({ type: 'not_provisioned' });
  });
});

describe('followStep: landing after a follow', () => {
  it('stays when the sign-in landed in the expected org', () => {
    const step = followStep(
      null,
      { type: 'landed', expectedOrgId: 'org_b', landedOrgId: 'org_b' },
      T0,
    );
    expect(step.action).toEqual({ type: 'stay' });
    expect(step.record).toEqual({ lastCheckedAt: T0, refused: null, failures: null });
  });

  it.each([['org_a'], [null]])(
    'reports a landing elsewhere (%s) at once and stops following',
    (landedOrgId) => {
      const [follow, landed, later] = run(null, [
        [checked('org_a', 'org_b'), T0],
        [{ type: 'landed', expectedOrgId: 'org_b', landedOrgId }, T0 + 1000],
        [checked(landedOrgId, 'org_b'), T0 + 6 * MIN],
      ]);
      expect(follow!.action.type).toBe('follow');
      expect(landed!.action).toEqual({ type: 'report', reason: 'landed_elsewhere' });
      expect(landed!.record.refused).toEqual({ activeOrgId: 'org_b', landedOrgId });
      expect(later!.action).toEqual({ type: 'stay' });
      expect(later!.record.refused).toEqual({ activeOrgId: 'org_b', landedOrgId });
    },
  );

  it('keeps checking while refused, so it sees the Active Org change', () => {
    const [, , dueStep] = run(null, [
      [{ type: 'landed', expectedOrgId: 'org_b', landedOrgId: 'org_a' }, T0],
      [checked('org_a', 'org_b'), T0 + 5 * MIN],
      [due, T0 + 10 * MIN],
    ]);
    expect(dueStep!.action.type).toBe('check');
  });

  it('keeps a refusal through temporary failures', () => {
    const steps = run(null, [
      [{ type: 'landed', expectedOrgId: 'org_b', landedOrgId: 'org_a' }, T0],
      [unavailable, T0 + 5 * MIN],
      [checked('org_a', 'org_b'), T0 + 10 * MIN],
    ]);
    expect(steps[1]!.record.refused).toEqual({ activeOrgId: 'org_b', landedOrgId: 'org_a' });
    expect(steps[2]!.action).toEqual({ type: 'stay' });
  });
});

describe('followStep: the record clears when the Active Org changes', () => {
  const refused: FollowRecord = {
    lastCheckedAt: T0,
    refused: { activeOrgId: 'org_b', landedOrgId: 'org_a' },
    failures: null,
  };

  it('follows the new Active Org', () => {
    const step = followStep(refused, checked('org_a', 'org_c'), T0 + 5 * MIN);
    expect(step.action).toEqual({ type: 'follow', orgId: 'org_c' });
    expect(step.record.refused).toBeNull();
  });

  it('stays when the Active Org changes to the session’s own', () => {
    const step = followStep(refused, checked('org_a', 'org_a'), T0 + 5 * MIN);
    expect(step.action).toEqual({ type: 'stay' });
    expect(step.record.refused).toBeNull();
  });

  it('is not provisioned when the Active Org goes away', () => {
    const step = followStep(refused, checked('org_a', null), T0 + 5 * MIN);
    expect(step.action).toEqual({ type: 'not_provisioned' });
    expect(step.record.refused).toBeNull();
  });

  it('clears a refusal once the session is in the Active Org', () => {
    const step = followStep(refused, checked('org_b', 'org_b'), T0 + 5 * MIN);
    expect(step.action).toEqual({ type: 'stay' });
    expect(step.record.refused).toBeNull();
  });
});

describe('followStep: temporary failures', () => {
  it('backs off 5, 15, then 60 minutes, and reports from the second in a row', () => {
    let record: FollowRecord | null = null;
    let now = T0;
    const seen: { action: string; wait: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const step = followStep(record, unavailable, now);
      record = step.record;
      seen.push({ action: step.action.type, wait: record.failures!.retryAt - now });
      now = record.failures!.retryAt;
    }
    expect(seen).toEqual([
      { action: 'skip', wait: 5 * MIN },
      { action: 'report', wait: 15 * MIN },
      { action: 'report', wait: 60 * MIN },
      { action: 'report', wait: 60 * MIN },
    ]);
  });

  it.each(['unavailable', 'no_token'] as const)('reports the reason %s', (reason) => {
    const [, second] = run(null, [
      [{ type: 'check_failed', reason }, T0],
      [{ type: 'check_failed', reason }, T0 + 5 * MIN],
    ]);
    expect(second!.action).toEqual({ type: 'report', reason });
    expect(second!.record.failures).toEqual({ reason, count: 2, retryAt: T0 + 20 * MIN });
  });

  it('skips until the back-off ends, past the 5-minute cap', () => {
    const [, second] = run(null, [
      [unavailable, T0],
      [unavailable, T0 + 5 * MIN],
    ]);
    const record = second!.record;
    expect(followStep(record, due, T0 + 15 * MIN).action.type).toBe('skip');
    expect(followStep(record, due, T0 + 20 * MIN - 1).action.type).toBe('skip');
    expect(followStep(record, due, T0 + 20 * MIN).action.type).toBe('check');
  });

  it('starts the count again after a successful check', () => {
    const steps = run(null, [
      [unavailable, T0],
      [checked('org_a', 'org_a'), T0 + 5 * MIN],
      [unavailable, T0 + 10 * MIN],
    ]);
    expect(steps[1]!.record.failures).toBeNull();
    expect(steps[2]!.action.type).toBe('skip');
    expect(steps[2]!.record.failures).toMatchObject({ count: 1, retryAt: T0 + 15 * MIN });
  });

  it('starts the count again after landing', () => {
    const steps = run(null, [
      [unavailable, T0],
      [{ type: 'landed', expectedOrgId: 'org_b', landedOrgId: 'org_b' }, T0 + MIN],
    ]);
    expect(steps[1]!.record.failures).toBeNull();
  });
});

describe('followStep: purity', () => {
  it('does not modify the record it is given', () => {
    const record: FollowRecord = {
      lastCheckedAt: T0,
      refused: { activeOrgId: 'org_b', landedOrgId: 'org_a' },
      failures: { reason: 'unavailable', count: 1, retryAt: T0 + 5 * MIN },
    };
    const copy = structuredClone(record);
    for (const input of [due, unavailable, checked('org_a', 'org_c')]) {
      followStep(record, input, T0 + 30 * MIN);
    }
    expect(record).toEqual(copy);
  });

  it('answers the same for the same arguments', () => {
    const a = followStep(null, checked('org_a', 'org_b'), T0);
    const b = followStep(null, checked('org_a', 'org_b'), T0);
    expect(a).toEqual(b);
  });

  it.each([NaN, Infinity])('throws on a now of %s', (now) => {
    expect(() => followStep(null, due, now)).toThrow(TypeError);
  });
});
