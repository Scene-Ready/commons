# Event standard

How Scene Ready apps tell each other that something changed. Every event goes through the Hub (`Scene-Ready/events`); apps never deliver events to each other directly. The overall design is the doc **Scene Ready — Cross-App Data Sharing Standard**.

## Envelope

CloudEvents 1.0 attribute names, plus `orgid` and `actor`. Types and validation are in `@scene-ready/commons/events`.

```json
{
  "specversion": "1.0",
  "id": "01JD8Z6Q4M3X7R2T9V5W1Y0BCA",
  "type": "platform.corrective_action.closed.v1",
  "source": "platform",
  "time": "2026-11-19T21:15:00Z",
  "orgid": "org_boone_fire",
  "subject": "sr:platform:task:tsk_482",
  "actor": "usr_abc123",
  "data": { "status": "closed" }
}
```

| Field     | Rule                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------- |
| `id`      | ULID (`newEventId`), set by the publisher when it writes its outbox row; subscribers dedupe on it |
| `type`    | `<source>.<record_type>.<past-tense verb>.v<major>`, owned by its source app                      |
| `source`  | The publisher's app key, set by the Hub from the caller's binding                                 |
| `time`    | When the change happened, RFC 3339 UTC                                                            |
| `orgid`   | The auth organization; every event belongs to exactly one                                         |
| `subject` | The reference of the record that changed, which the source app owns                               |
| `actor`   | The acting user who caused it, when there is one                                                  |
| `data`    | Small, non-sensitive hints only (at most 2 KB). Never personal data or a whole record             |

## Semantics

- **Hints, not state.** A subscriber that needs details calls the owner's API with its own token, so access rules apply at read time.
- **At least once, any order.** Subscribers dedupe by `id`, and compare against the state they refetch when order matters.
- **Owned types.** Each type is documented in its source app's repo beside its API. A breaking change is a new major version (`.v2`), published alongside the old one until subscribers move.
- **Owned subjects.** An app publishes events only about records it owns: the `subject` reference names the `source` app.
- **One spelling.** App keys use lowercase letters, digits and single hyphens (`rig-prep`); Record types and verbs are snake_case (`corrective_action`, `closed`). References use the same rules, per [ADR-0003](../adr/0003-references-are-sr-strings.md).
- **Strict in, lenient out.** The Hub rejects a published event with an attribute this standard does not define. Subscribers ignore attributes they do not know, so the envelope can gain optional attributes without a new major version.

## Publishing

Publishers call the Hub over a service binding (`EVENTS_HUB`), and every publisher keeps a **transactional outbox**. D1 apps use `@scene-ready/commons/outbox`, which implements these rules ([ADR-0006](../adr/0006-outbox-design.md)):

1. Write the outbox row in the same D1 batch, or the same Durable Object transaction, as the change.
2. Set the event `id` then, so every retry carries the same id.
3. Send after commit, inside `ctx.waitUntil`, so the user's request never waits on the Hub.
4. Clear the row only when the Hub acknowledges it.
5. Sweep unacknowledged rows on a cron trigger (D1 apps) or a Durable Object alarm, with backoff.
6. Keep a rejected event in the outbox, marked rejected, and never retry it. A rejection is a publisher bug: fix it, then remove the row.
7. Retry unacknowledged rows indefinitely, with backoff capped at one hour. Never drop an event the Hub hasn't acknowledged.

The Hub acknowledges only after writing the event to its log, and treats a repeated `id` as already published.

## Delivery

Each subscription has an HTTPS endpoint and a secret. The Hub POSTs the envelope as the body (`Content-Type: application/cloudevents+json`) with these headers:

| Header             | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `X-SR-Event-Id`    | The event id; dedupe on it                            |
| `X-SR-Event-Type`  | The event type                                        |
| `X-SR-Delivery-Id` | One per (event, subscription); stable across attempts |
| `X-SR-Attempt`     | 1 on the first try, then counting up                  |
| `X-SR-Timestamp`   | Unix seconds when signed                              |
| `X-SR-Signature`   | `t=<timestamp>,v1=<hex>`                              |

The signature is auth's webhook scheme ([ADR-0004](../adr/0004-deliveries-signed-with-auths-webhook-scheme.md)): `v1 = hex(HMAC-SHA256(key, "v1:" + timestamp + ":" + raw_body))`, where `key` is the text of `base64url(SHA-256(secret))`. Subscribers verify with `verifyDelivery`, reject timestamps more than 300 seconds off, and must read the raw body before parsing.

Any 2xx is success. Anything else is retried or permanent, by this policy:

|                          | Policy                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempts                 | 10                                                                                                                                                                                                 |
| Gap before attempts 2–10 | 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m, 64 m, 128 m, each ±20% jitter; about 4¼ hours in total                                                                                                       |
| Retried                  | 5xx, 429, 408, 425, timeouts (10 seconds per attempt), network errors                                                                                                                              |
| Permanent                | 409, every other 4xx, and any 3xx: the Hub doesn't follow redirects, so register the final URL                                                                                                     |
| `Retry-After`            | Honoured on 429 and 503 only, as `max(gap, min(Retry-After, 1 hour))`: it can lengthen a gap, never shorten one, and it still counts as an attempt. The longest possible window is about 10 hours. |
| Giving up                | After the last attempt, or on a permanent status, the delivery has failed and nothing sends it again. The Hub logs it at error level.                                                              |
| Disabled subscription    | Its pending deliveries fail without an attempt.                                                                                                                                                    |

Subscribers:

- Answer within 10 seconds; do slow work after responding.
- Answer 2xx for an event you've already processed, deduping on `id`. Don't answer a duplicate with 409.
- Don't rely on order. Later attempts reorder deliveries, and an event can arrive hours after a newer one on the same subject. Never apply `data` as a change to your copy; dedupe, then refetch the record from its owner.
- Recover with Catch-up after a delivery fails, after an outage, or after your subscription is re-enabled: catch up from `cursorAt(<a time you know you were healthy>)` and dedupe on `id`. Event ids aren't contiguous, so the last id you received can sit past a gap.

A subscription receives events only for organizations its app has an org relationship with, and only for types its scopes allow.

## Catch-up

The Hub keeps every event for 7 days. A subscriber that missed deliveries reads a paged feed of its events by cursor over its service binding, then resumes normal delivery.

A cursor is any event id, or `cursorAt(ms)` from `@scene-ready/commons/events`, the lowest id for a millisecond. The feed returns the events after the cursor, oldest first.

If Catch-up answers `cursor_expired`, the cursor is older than the 7 days the Hub keeps, and the events can't be recovered. Fetch current state in full from each owner's API, then catch up from `cursorAt(<the time the full fetch started>)`.
