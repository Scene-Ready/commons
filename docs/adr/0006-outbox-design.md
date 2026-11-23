---
status: accepted
---

# The outbox deletes on ack, parks rejections, and retries forever

`@scene-ready/commons/outbox` implements the event standard's Publishing rules once, for every D1 app. A row is deleted as soon as the Hub acknowledges its event, a duplicate ack included: from then on the Hub's log is the record, so the outbox keeps no history. A row the Hub rejects is kept with `rejected_at` and the Hub's `errors`, logged at error level and never retried automatically. `outboxStatements` and the Hub run the same check (`validateDraft`), so a rejection means they disagree: usually they run different commons versions, or the binding is misconfigured and the Hub can't identify the App. The cause can be outside the publisher and the stored event valid as written, so a person fixes the cause, then either deletes the row or calls `resendRejected`, which makes it due now for the next sweep. Since a rejection parks an event, the Hub answers `ok: false` only for those two causes; any other failure throws, and the outbox retries it. A row whose send throws is retried forever, backing off from 30 seconds to a one-hour cap with ±20% jitter, and from its eighth attempt (about an hour) every failure is logged at error level and reported `stuck`. Commons does no alerting; the owner alerts on that log line.

There is one `outbox_event` table per D1 database an app writes events from, owned and migrated by the app ([ADR-0005](0005-modules-may-define-app-owned-tables.md)). The module is typed against D1 directly, with no storage interface; Durable Objects get their own entry point, `outbox/do`, rather than an abstraction over both.

## Considered options

- **Mark acknowledged rows sent instead of deleting them.** Rejected: the Hub already keeps the log, and a second copy grows forever.
- **Give up after N attempts or a dead-letter table.** Rejected: an unacknowledged event is one the Hub has never seen, so dropping it loses the event for good. Retrying is cheap, and the stuck log line gets a person involved.
- **Retry rejected rows automatically.** Rejected: the Hub's check is deterministic, so retrying before a person fixes the drift fails the same way and hides it.
- **Delete rejected rows, leaving no way to resend.** Rejected: when the drift was the Hub's or the binding's, the event is valid, and deleting it loses it for subscribers for good.
- **A storage interface over D1 and Durable Object storage.** Rejected until there are two real adapters: the transaction APIs differ (`db.batch` against `transactionSync`), and an interface designed from one would be wrong for the other.
- **Locking between `sendPending` and the sweep.** Rejected: the Hub acknowledges a repeated id as a duplicate, so an overlap sends an event twice but publishes it once. A failed Attempt is recorded only if the row is unchanged since it was read, so overlapping failures count once.

## Consequences

- `sendPending` takes the drafts the Publisher already holds, so the request path never reads the outbox back. Called for a batch that didn't commit, it publishes an event whose change rolled back. That can't be detected without a read, but when such a send also fails, the missing row is logged at warning level.
- New rows aren't due for 60 seconds, so the sweep doesn't race the send right after commit.
- The D1 parameter types are structural (`D1DatabaseLike`), so commons builds without Workers types while apps pass `env.DB` unchanged.
