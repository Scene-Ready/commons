# API standard

How one Scene Ready app calls another. Each app owns its API and its resources, named in its own glossary; these rules are what every app-to-app API shares. The overall design is the doc **Scene Ready — Cross-App Data Sharing Standard**.

## Identity

- The calling app presents a **client-credentials access token** from auth as `Authorization: Bearer <token>`.
- The receiving app verifies it locally against auth's JWKS (issuer, audience, expiry, signature); no call to auth per request.

## Scopes

- One scope per capability: `<owner>:<resource>.<read|write>`, for example `platform:roster.read`, `platform:tasks.write`.
- Auth's per-client scope allow-list is the grant. The receiving app checks the scope on every route.

## Tenancy

- Every route is scoped to an auth organization in its path: `/api/m2m/v1/orgs/{orgId}/…`.
- The receiving app refuses an organization the calling app has no org relationship with, and never takes an organization id from a request body.

## Acting user

- A call made for a person carries that user's auth id in `Scene-Ready-Acting-User`; the receiving app applies that user's role from its own schema.
- A call made by the app itself (a webhook handler, a job) omits it and is limited to what the scope allows.
- Status: proposed (decision D2 in the design doc).

## Versions

- The major version is in the path (`/v1/`). Additive changes ship in place; a breaking change ships as `/v2/` beside `/v1/` until every caller has moved.

## Errors

Problem Details JSON ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with `Content-Type: application/problem+json`: `type`, `title`, `status`, `detail`, plus a stable `code` callers branch on.

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| 401    | Missing, invalid or expired token                 |
| 403    | Scope or organization not allowed for this caller |
| 404    | Not found, or not visible to this caller          |
| 409    | Conflict with the current state                   |
| 429    | Slow down; honour `Retry-After`                   |

## Cross-app references

- A pointer to another app's record is `sr:<app>:<type>:<id>` (`@scene-ready/commons/refs`), per [ADR-0003](../adr/0003-references-are-sr-strings.md), for example `sr:platform:location:loc_123`.
- The owner documents how to resolve each type it exposes.
- A reference whose target is gone resolves to 404; the holder shows it as unavailable and keeps its own record.
- A holder may cache a display value (a name) beside the reference, refreshed from the owner and never edited locally.

## Idempotency

A write that may be retried takes an `Idempotency-Key` header. The receiver returns the first result for a repeated key for at least 24 hours.
