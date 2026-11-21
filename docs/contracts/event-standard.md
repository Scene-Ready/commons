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
- **Strict in, lenient out.** The Hub rejects a published event with an attribute this standard does not define. Subscribers ignore attributes they do not know, so the envelope can gain optional attributes without a new major version.

## Publishing

Publishers call the Hub over a service binding (`EVENTS_HUB`), and every publisher keeps a **transactional outbox**:

1. Write the outbox row in the same D1 batch, or the same Durable Object transaction, as the change.
2. Set the event `id` then, so every retry carries the same id.
3. Send after commit, inside `ctx.waitUntil`, so the user's request never waits on the Hub.
4. Clear the row only when the Hub acknowledges it.
5. Sweep unacknowledged rows on a cron trigger (D1 apps) or a Durable Object alarm, with backoff.

The Hub acknowledges only after writing the event to its log, and treats a repeated `id` as already published.

## Delivery

Each subscription has an HTTPS endpoint and a secret. The Hub POSTs the envelope as the body (`Content-Type: application/cloudevents+json`) with these headers:

| Header             | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `X-SR-Event-Id`    | The event id; dedupe on it                           |
| `X-SR-Event-Type`  | The event type                                       |
| `X-SR-Delivery-Id` | One per (event, subscription); stable across retries |
| `X-SR-Attempt`     | 1 on the first try, then counting up                 |
| `X-SR-Timestamp`   | Unix seconds when signed                             |
| `X-SR-Signature`   | `t=<timestamp>,v1=<hex>`                             |

The signature is auth's webhook scheme ([ADR-0004](../adr/0004-deliveries-signed-with-auths-webhook-scheme.md)): `v1 = hex(HMAC-SHA256(key, "v1:" + timestamp + ":" + raw_body))`, where `key` is the text of `base64url(SHA-256(secret))`. Subscribers verify with `verifyDelivery`, reject timestamps more than 300 seconds off, and must read the raw body before parsing.

- Any 2xx is success. 5xx, timeouts and 429 (honouring `Retry-After`) are retried with backoff; other 4xx are permanent.
- A subscription receives events only for organizations its app has an org relationship with, and only for types its scopes allow.

## Catch-up

The Hub keeps every event for 7 days. A subscriber that missed deliveries reads a paged feed of its events by cursor over its service binding, then resumes normal delivery.
