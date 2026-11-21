# Changelog

Grouped by entry point. Versions follow semver across the whole package.

## 0.2.0 — Unreleased

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
