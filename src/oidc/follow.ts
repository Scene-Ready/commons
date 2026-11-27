/**
 * Org follow (home ADR 0002) as one pure function. Each app stores the
 * `FollowRecord` with its session, feeds `followStep` what happened and does
 * what it answers. No I/O and no clock reads: time comes in as `now`.
 */

const MINUTE = 60_000;

/** Auth is checked at most this often per session (ADR 0002 "Apps poll"). */
const CHECK_INTERVAL_MS = 5 * MINUTE;

/** The wait after the 1st, 2nd and 3rd-or-later temporary failure in a row. */
const BACKOFF_MS = [5 * MINUTE, 15 * MINUTE, 60 * MINUTE] as const;

/** Temporary failures are reported from this many in a row. */
const REPORT_AFTER_FAILURES = 2;

export type TemporaryFollowFailure = 'unavailable' | 'no_token';

/** Where the silent sign-in of a follow was meant to land, and where it did (null for no org). */
export interface Landing {
  expectedOrgId: string;
  landedOrgId: string | null;
}

/**
 * What a session remembers about Org follow. Plain JSON; times are epoch ms.
 * Start a session with `null`, and carry the record over the silent sign-in
 * of a follow, so a refusal outlives the session that ended.
 */
export interface FollowRecord {
  /** The last check, whether it succeeded or failed. */
  lastCheckedAt: number | null;
  /**
   * A lasting refusal: the landing that missed. Following stops while the
   * Active Org is still `expectedOrgId`.
   */
  refused: Landing | null;
  /** The run of temporary failures in a row; checks wait until `retryAt`. */
  failures: { reason: TemporaryFollowFailure; count: number; retryAt: number } | null;
}

export type FollowInput =
  /** The app loaded, or its window got focus. Both are treated alike. */
  | { type: 'due'; trigger: 'load' | 'focus' }
  /** A check succeeded: the session's org and auth's Active Org (from userinfo), null for none. */
  | { type: 'checked'; sessionOrgId: string | null; activeOrgId: string | null }
  /** A check failed for a temporary reason. A 401 is not this: refresh, then sign in silently. */
  | { type: 'check_failed'; reason: TemporaryFollowFailure }
  /** The silent sign-in of a follow finished. */
  | ({ type: 'landed' } & Landing);

export type FollowAction =
  /** Check auth's Active Org now (userinfo), then send `checked` or `check_failed`. */
  | { type: 'check' }
  /** Nothing to do now. */
  | { type: 'skip' }
  /** The session is where it should be, or can't follow; keep it. */
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

const INITIAL_RECORD: FollowRecord = { lastCheckedAt: null, refused: null, failures: null };

/** The record after a check or landing at `now`, holding only `refused`. */
function checkedAt(now: number, refused: Landing | null = null): FollowRecord {
  return { lastCheckedAt: now, refused, failures: null };
}

/**
 * One step of Org follow: given a session's follow record, what just happened
 * and the time, what the app does next and the record to store.
 *
 * - `due` answers `check`, or `skip` within 5 minutes of the last check or
 *   while backing off. A last check in the future (another machine's clock)
 *   holds nothing back.
 * - `checked` answers `not_provisioned` with no Active Org, `stay` when the
 *   session is in it, otherwise `follow`, unless a lasting refusal for that
 *   same Active Org stands (then `stay`, silently: it was reported when it
 *   happened, and stays readable as `record.refused`). The refusal clears on
 *   the first check that sees another Active Org or the session in it; a
 *   change and a change back between two checks can't be seen, so it stands.
 * - `check_failed` backs off 5, 15, then 60 minutes, and answers `report` from
 *   the second failure in a row, whatever the reasons (`skip` before it).
 * - `landed` answers `stay` in the expected org; elsewhere it records a
 *   lasting refusal and answers `report` at once.
 */
export function followStep(
  record: FollowRecord | null,
  input: FollowInput,
  now: number,
): FollowStep {
  if (!Number.isFinite(now)) throw new TypeError('followStep: now must be epoch ms');
  const current = record ?? INITIAL_RECORD;

  switch (input.type) {
    case 'due': {
      const { lastCheckedAt, failures } = current;
      // `retryAt` is set from the same clock as `lastCheckedAt`, so a last
      // check in the future discounts both the cap and the back-off.
      if (lastCheckedAt === null || lastCheckedAt > now) {
        return { action: { type: 'check' }, record: current };
      }
      const until = Math.max(lastCheckedAt + CHECK_INTERVAL_MS, failures?.retryAt ?? 0);
      return { action: { type: now < until ? 'skip' : 'check' }, record: current };
    }

    case 'checked': {
      const { sessionOrgId, activeOrgId } = input;
      // A successful check ends a run of temporary failures.
      const refused =
        current.refused?.expectedOrgId === activeOrgId && sessionOrgId !== activeOrgId
          ? current.refused
          : null;
      const next = checkedAt(now, refused);
      if (activeOrgId === null) return { action: { type: 'not_provisioned' }, record: next };
      if (sessionOrgId === activeOrgId || refused) {
        return { action: { type: 'stay' }, record: next };
      }
      return { action: { type: 'follow', orgId: activeOrgId }, record: next };
    }

    case 'check_failed': {
      const count = (current.failures?.count ?? 0) + 1;
      const wait = BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1]!;
      const next: FollowRecord = {
        ...current,
        lastCheckedAt: now,
        failures: { reason: input.reason, count, retryAt: now + wait },
      };
      const action: FollowAction =
        count >= REPORT_AFTER_FAILURES
          ? { type: 'report', reason: input.reason }
          : { type: 'skip' };
      return { action, record: next };
    }

    case 'landed': {
      const { expectedOrgId, landedOrgId } = input;
      if (landedOrgId === expectedOrgId)
        return { action: { type: 'stay' }, record: checkedAt(now) };
      return {
        action: { type: 'report', reason: 'landed_elsewhere' },
        record: checkedAt(now, { expectedOrgId, landedOrgId }),
      };
    }
  }
}
