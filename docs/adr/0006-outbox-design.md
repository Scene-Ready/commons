---
status: accepted
---

# The outbox deletes on ack, keeps rejections, and retries forever

`@scene-ready/commons/outbox` implements the event standard's Publishing rules once, for every D1 app. A row is deleted as soon as the Hub acknowledges its event, a duplicate ack included: from then on the Hub's log is the record, so the outbox keeps no history. A row the Hub rejects is kept with `rejected_at` and the Hub's `errors`, logged at error level and never retried. A rejection is a publisher bug, so resending would fail the same way and hide the bug; the owner fixes the publisher and deletes the row by hand. A row whose send throws is retried forever, backing off from 30 seconds to a one-hour cap with ±20% jitter, and from its eighth attempt (about an hour) every failure is logged at error level and reported `stuck`. Commons does no alerting; the owner alerts on that log line.

There is one `outbox_event` table per D1 database an app writes events from, owned and migrated by the app ([ADR-0005](0005-modules-may-define-app-owned-tables.md)). The module is typed against D1 directly, with no storage interface; Durable Objects get their own entry point, `outbox/do`, rather than an abstraction over both.

## Considered options

- **Mark acknowledged rows sent instead of deleting them.** Rejected: the Hub already keeps the log, and a second copy grows forever.
- **Give up after N attempts or a dead-letter table.** Rejected: an unacknowledged event is one the Hub has never seen, so dropping it loses the event for good. Retrying is cheap, and the stuck log line gets a person involved.
- **Retry rejected rows.** Rejected: the Hub's check is deterministic. `outboxStatements` runs the same check (`validateDraft`) before commit, so a rejection means the two have drifted, and that needs a person.
- **A storage interface over D1 and Durable Object storage.** Rejected until there are two real adapters: the transaction APIs differ (`db.batch` against `transactionSync`), and an interface designed from one would be wrong for the other.
- **Locking between `sendPending` and the sweep.** Rejected: the Hub acknowledges a repeated id as a duplicate, so an overlap sends an event twice but publishes it once. A failed Attempt is recorded only if the row is unchanged since it was read, so overlapping failures count once.

## Consequences

- `sendPending` takes the drafts the Publisher already holds, so the request path never reads the outbox back.
- New rows aren't due for 60 seconds, so the sweep doesn't race the send right after commit.
- The D1 parameter types are structural (`D1DatabaseLike`), so commons builds without Workers types while apps pass `env.DB` unchanged.
