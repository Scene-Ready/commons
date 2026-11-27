/**
 * Org follow (home ADR 0002) as one pure function. Each app stores the
 * `FollowRecord` with its session, feeds `followStep` what happened and does
 * what it answers. No I/O and no clock reads: time comes in as `now`.
 */

const MINUTE = 60_000;

/** Auth is checked at most this often per session (ADR 0002 "Apps poll"). */
export const FOLLOW_CHECK_INTERVAL_MS = 5 * MINUTE;

/** The wait after the 1st, 2nd and 3rd-or-later temporary failure in a row. */
export const FOLLOW_BACKOFF_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, 60 * MINUTE];

/** `followStep` reports temporary failures from this many in a row. */
export const FOLLOW_REPORT_AFTER_FAILURES = 2;

export type TemporaryFollowFailure = 'unavailable' | 'no_token';

/**
 * What a session remembers about Org follow. Plain JSON; times are epoch ms.
 * Start a session with `null`, and carry the record over the silent sign-in
 * of a follow, so a refusal outlives the session that ended.
 */
export interface FollowRecord {
  /** The last check, whether it succeeded or failed. */
  lastCheckedAt: number | null;
  /**
   * A lasting refusal: the silent sign-in to `activeOrgId` landed on
   * `landedOrgId` instead. Following stops while the Active Org is still
   * `activeOrgId`.
   */
  refused: { activeOrgId: string; landedOrgId: string | null } | null;
  /** The run of temporary failures in a row; checks wait until `retryAt`. */
  failures: { reason: TemporaryFollowFailure; count: number; retryAt: number } | null;
}

export type FollowInput =
  /** The app loaded, or its window got focus. */
  | { type: 'due'; trigger: 'load' | 'focus' }
  /** A check succeeded: the session's org and auth's Active Org (from userinfo), null for none. */
  | { type: 'checked'; sessionOrgId: string | null; activeOrgId: string | null }
  /** A check failed for a temporary reason. A 401 is not this: refresh, then sign in silently. */
  | { type: 'check_failed'; reason: TemporaryFollowFailure }
  /** The silent sign-in of a follow finished, in `landedOrgId` (null for no org). */
  | { type: 'landed'; expectedOrgId: string; landedOrgId: string | null };

export type FollowAction =
  /** Check auth's Active Org now (userinfo), then send `checked` or `check_failed`. */
  | { type: 'check' }
  /** Nothing to do now. */
  | { type: 'skip' }
  /** The session is where it should be; keep it. */
  | { type: 'stay' }
  /** Save pending work, end the session and sign in silently; then send `landed`. */
  | { type: 'follow'; orgId: string }
  /** There is no Active Org: show the not-provisioned page. */
  | { type: 'not_provisioned' }
  /** Tell the person following failed, and why. The session stays where it is. */
  | { type: 'report'; reason: TemporaryFollowFailure | 'landed_elsewhere' };

export interface FollowStep {
  action: FollowAction;
  record: FollowRecord;
}

const EMPTY: FollowRecord = { lastCheckedAt: null, refused: null, failures: null };

/**
 * One step of Org follow: given a session's follow record, what just happened
 * and the time, what the app does next and the record to store.
 *
 * - `due` answers `check`, or `skip` within 5 minutes of the last check or
 *   while backing off. Load and focus are treated alike.
 * - `checked` answers `not_provisioned` with no Active Org, `stay` when the
 *   session is in it, otherwise `follow`, unless a lasting refusal for that
 *   same Active Org stands (then `stay`). The record clears when the Active
 *   Org changes.
 * - `check_failed` backs off 5, 15, then 60 minutes, and answers `report` from
 *   the second failure in a row (`skip` before it).
 * - `landed` answers `stay` in the expected org; elsewhere it records a
 *   lasting refusal and answers `report` at once.
 */
export function followStep(
  record: FollowRecord | null,
  input: FollowInput,
  now: number,
): FollowStep {
  if (!Number.isFinite(now)) throw new TypeError('followStep: now must be epoch ms');
  const current = record ?? EMPTY;

  switch (input.type) {
    case 'due': {
      const { lastCheckedAt, failures } = current;
      // A last check in the future (another isolate's clock) doesn't hold checks back.
      const recent =
        lastCheckedAt !== null &&
        lastCheckedAt <= now &&
        now - lastCheckedAt < FOLLOW_CHECK_INTERVAL_MS;
      const backingOff = failures !== null && now < failures.retryAt;
      return { action: { type: recent || backingOff ? 'skip' : 'check' }, record: current };
    }

    case 'checked': {
      const { sessionOrgId, activeOrgId } = input;
      // A successful check ends a run of temporary failures. A lasting refusal
      // holds only while the Active Org is the one it was for and the session
      // is not in it; otherwise the record clears.
      const refused =
        current.refused?.activeOrgId === activeOrgId && sessionOrgId !== activeOrgId
          ? current.refused
          : null;
      const next: FollowRecord = { lastCheckedAt: now, refused, failures: null };
      if (activeOrgId === null) return { action: { type: 'not_provisioned' }, record: next };
      if (sessionOrgId === activeOrgId || refused)
        return { action: { type: 'stay' }, record: next };
      return { action: { type: 'follow', orgId: activeOrgId }, record: next };
    }

    case 'check_failed': {
      const count = (current.failures?.count ?? 0) + 1;
      const wait = FOLLOW_BACKOFF_MS[Math.min(count, FOLLOW_BACKOFF_MS.length) - 1]!;
      const next: FollowRecord = {
        ...current,
        lastCheckedAt: now,
        failures: { reason: input.reason, count, retryAt: now + wait },
      };
      const action: FollowAction =
        count >= FOLLOW_REPORT_AFTER_FAILURES
          ? { type: 'report', reason: input.reason }
          : { type: 'skip' };
      return { action, record: next };
    }

    case 'landed': {
      const { expectedOrgId, landedOrgId } = input;
      if (landedOrgId === expectedOrgId) {
        return {
          action: { type: 'stay' },
          record: { lastCheckedAt: now, refused: null, failures: null },
        };
      }
      return {
        action: { type: 'report', reason: 'landed_elsewhere' },
        record: {
          lastCheckedAt: now,
          refused: { activeOrgId: expectedOrgId, landedOrgId },
          failures: null,
        },
      };
    }
  }
}
