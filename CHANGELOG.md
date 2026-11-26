# Changelog

Grouped by entry point. Versions follow semver across the whole package.

## Unreleased

- `oidc/claims`: New entry point, the claims auth puts in ID tokens and userinfo, under auth's wire names: `Identity`, `Organization`, `Entitlements`, `ProductEntitlement` and `TokenSet`. `parseIdentity(payload)` reads `sub`, `email`, `name`, `picture`, `is_platform_admin`, `urn:auth:organizations` and `urn:auth:entitlements`; it drops a malformed organization or product and keeps the rest, ignores unknown fields, and throws a `TypeError` without `sub`. No dependencies.
- `oidc/testing`: New entry point for apps' tests. `createFakeIssuer({ issuer? })` answers discovery, JWKS, authorize, token, userinfo, end-session and revocation through the `fetch` it returns, with no server or ports, under Node and workerd. It signs ES256 ID and access tokens with chosen claims (`idToken`, `accessToken`), and scripts the next authorize (`nextAuthorize`: a code or a refusal such as `login_required`), token and userinfo outcomes (`nextToken`, `nextUserInfo`: claims, an OAuth error such as `invalid_grant`, or a status such as a 5xx). Nothing in `oidc` or `oidc/claims` imports it; lint enforces that. No dependencies.

## 0.8.0 — 2026-11-25

- `events`: `X-SR-Signature` may carry several `v1` signatures, so a subscription's secret can rotate without a gap (ADR-0007). `verifyDelivery` accepts a delivery if any `v1` matches its `secret`, and refuses a header with more than two. `signBody` takes `[newKey, oldKey]` during an overlap and puts the old key's signature last.
- **Upgrade order:** a subscriber must be on 0.8.0 before it switches to a new secret during an overlap; older releases read only the last `v1`, the old key's.

## 0.7.0 — 2026-11-25

- `notifications`: New entry point, the notifications Worker as apps see it over their `NOTIFY` service binding. `Notify.sendEmail(input)` sends a transactional email; apps send content (`MessageContent` or `AlertContent`, matching design-system's `wrapSimpleMessage` and `wrapIncidentAlert`), never HTML, and get a `SendResult`. `validateEmailInput(input)` checks an email as notifications will on receipt and returns only the fields the contract defines.
- ADR-0001: the email wrappers stay in design-system; the planned `email` entry point is dropped.

## 0.6.0 — 2026-11-23

- `outbox`: `STUCK_AFTER_ATTEMPTS` (8), the failed Attempt from which the outbox logs a row as stuck, is exported.
- `outbox`: `listStuck(db, { now?, limit? })` lists the rows the outbox reports stuck, oldest first, as `StuckEvent`s (with `lastError` and `nextAttemptAt`), for an admin view. A row that is due at `now` is left out, so a row `resendRejected` just made due isn't listed until the sweep has tried it. Publishers that copied the 8 into their own query can use this instead.

## 0.5.0 — 2026-11-23

- `outbox`: `resendRejected(db, id, { now? })` clears a row's rejection and makes it due, so the next sweep sends it. Call it after fixing the cause of a rejection (the Hub on a different commons version, a misconfigured binding). Rejected rows are still never retried automatically (ADR-0006).
- `outbox`: `sendPending` logs a warning (`no outbox row for this event; was the batch committed?`) when a first send fails and the event has no row. Send only after `await db.batch(...)` resolves.
- `events`: **Breaking** for the Hub. `EventsHub.publish` answers `ok: false` only for a draft that fails `validateDraft` or an App the Hub can't identify; any other failure throws, so the publisher retries it. The event standard's Publishing section says the same, and rule 6 now reads "fix it, then remove or resend the row". The outbox's handling of `ok: false` and of a throw is unchanged, so this is not breaking for publishers.
- **Upgrade order:** deploy the Hub with Scene-Ready/events#14 (temporary failures throw) before auth moves past v0.3.0. An older Hub answers temporary failures with `ok: false`, which parks events as rejected; resend any it parked with `resendRejected`.

## 0.4.0 — 2026-11-22

- `events`: `cursorAt(ms)`, the lowest event id for a millisecond, to use as a Catch-up cursor when recovering missed deliveries.
- Event standard, Delivery: one retry policy for the Hub (10 attempts over about 4¼ hours, which statuses are retried, `Retry-After` honoured on 429 and 503 up to 1 hour, no redirects) and the rules subscribers follow: answer within 10 seconds, answer duplicates with 2xx, don't rely on order, recover with Catch-up. Catch-up: what to do on `cursor_expired`.

## 0.3.0 — 2026-11-21

- `outbox`: New entry point, the publisher's transactional outbox on D1: `outboxStatements`, `sendPending`, `sweepOutbox`, `listRejected`, `nextAttemptAt` and `OUTBOX_SCHEMA_VERSION`. See ADR-0006.
- `outbox`: **Copy `migrations/outbox/0001_outbox_event.sql`** into each D1 database you publish events from, under your own migration number.
- `events`: `EventsHub`, the Hub's `publish` and `catchUp` as apps see them over `EVENTS_HUB`, with `PublishResult` and `CatchUpResult`.
- `events`: `validateDraft(draft, app)` checks a draft as the Hub will once `app` publishes it. The outbox and the Hub both use it.

## 0.2.0 — 2026-11-21

- `refs`: **Breaking.** `parseRef`, `isRef` and `formatRef` follow ADR-0003's spelling: app keys use lowercase letters, digits and single hyphens (`rig-prep`, not `rig_prep`), and Record types are snake_case (`corrective_action`, not `corrective-action`).
- `events`: **Breaking.** `validateEvent` rejects an event whose `subject` names a record the `source` app does not own (`subject must be a reference owned by "<source>"`), per the event standard's owned-subjects rule.
- `events`: **Breaking.** `validateEvent` and `isEventType` use the same rules for `source` and for the `<source>` and `<record_type>` segments of an Event type. The verb stays snake_case, and a type must have exactly four segments, `<source>.<record_type>.<verb>.v<major>` (`platform.task.v1` no longer passes). Its error now reads `type must be <source>.<record_type>.<verb>.v<major>`.
- `events`: `validateEvent` takes `{ unknownAttributes: 'reject' | 'ignore' }` (the `ValidateOptions` type), defaulting to `'reject'`. `verifyDelivery` uses `'ignore'`, so a signed delivery with an attribute the subscriber doesn't know is accepted and the attribute is left out of the returned event, per the event standard's "strict in, lenient out" rule.
- `events`: **Breaking.** Error messages: an unknown attribute is reported as `unknown attribute: <name>` (was `unknown field: <name>`), and an event with an invalid `source` no longer also gets a `type must start with` error.
- `qr`: **Breaking.** The names follow the `logo` option. `QrMark` and `QrMarkPath` are renamed `QrLogo` and `QrLogoPath`, and `SCENE_READY_MARK` is renamed `SCENE_READY_LOGO`. `BrandedQr.logo` is renamed `BrandedQr.plate`, and `QrLogoPlate.mark` is renamed `QrLogoPlate.logo`, so the logo drawn is `brandedQr(text).plate?.logo`.

## 0.1.0 — 2026-11-20

- `refs`: `parseRef`, `formatRef`, `isRef` for `sr:<app>:<type>:<id>` references.
- `events`: the event envelope, `validateEvent`, `isEventType`, `newEventId`, and signed delivery (`signingKey`, `signBody`, `verifyDelivery`, `HEADER`).
- `qr`, `qr/react`: branded QR codes, moved unchanged from RigPrep Sim's `src/shared/qr-code`.
