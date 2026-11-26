# @scene-ready/commons

Shared code for Scene Ready apps: cross-app references, the event standard and its outbox, branded QR codes, the notifications contract, and OIDC sign-in with auth and the claims it issues. One package with an entry point per module, so each app imports only what it uses.

| Entry point                          | What it holds                                                                                                                                                                                                                                                             | Runs in       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `@scene-ready/commons/refs`          | `sr:<app>:<type>:<id>` references: `parseRef`, `formatRef`, `isRef`                                                                                                                                                                                                       | anywhere      |
| `@scene-ready/commons/events`        | The event envelope, `validateEvent`, `validateDraft`, `newEventId`, `cursorAt`, the Hub's interface (`EventsHub`), signed delivery (`verifyDelivery`)                                                                                                                     | Workers, Node |
| `@scene-ready/commons/outbox`        | The publisher's transactional outbox on D1: `outboxStatements`, `sendPending`, `sweepOutbox`, `resendRejected`, `listRejected`, `listStuck`                                                                                                                               | Workers       |
| `@scene-ready/commons/qr`            | Branded QR codes as data or a standalone SVG string (`brandedQrSvg`)                                                                                                                                                                                                      | anywhere      |
| `@scene-ready/commons/notifications` | The notifications Worker as apps see it over `NOTIFY`: `sendEmail` (`Notify`, `EmailInput`, `SendResult`) and `validateEmailInput`                                                                                                                                        | anywhere      |
| `@scene-ready/commons/qr/react`      | `<QrCode>` for React apps                                                                                                                                                                                                                                                 | browser, SSR  |
| `@scene-ready/commons/oidc`          | The client apps use with auth: `createOidcClient` for sign-in (`startSignIn`, `finishSignIn`), `refresh`, `isExpiring`, `userInfo`, `setActiveOrganization`, sign-out (`endSessionUrl`, `revoke`); re-exports `oidc/claims`. Server-side only: it holds the client secret | Workers, Node |
| `@scene-ready/commons/oidc/claims`   | The claims auth issues, typed (`Identity`, `Organization`, `Entitlements`, `TokenSet`), and `parseIdentity` for an ID token payload or userinfo                                                                                                                           | anywhere      |
| `@scene-ready/commons/oidc/testing`  | For apps' tests only: `createFakeIssuer`, an OIDC issuer behind a `fetch` that signs tokens with chosen claims and scripts authorize, token, userinfo and set-active-org outcomes                                                                                         | anywhere      |

The standards these modules enforce are in [`docs/contracts/`](docs/contracts/): the [API standard](docs/contracts/api-standard.md) and the [event standard](docs/contracts/event-standard.md). The overall design is the doc **Scene Ready — Cross-App Data Sharing Standard**.

## Install

Pin a release tag:

```sh
npm install github:Scene-Ready/commons#v0.4.0
```

npm builds the package on install (`prepare`). It writes git dependencies to `package-lock.json` as `git+ssh://` URLs, so CI without an SSH key needs this once before `npm ci`:

```sh
git config --global url."https://github.com/".insteadOf ssh://git@github.com/
```

React is an optional peer dependency, needed only for `qr/react`.

## Use

```ts
import { parseRef } from '@scene-ready/commons/refs';
import { verifyDelivery } from '@scene-ready/commons/events';
import { brandedQrSvg } from '@scene-ready/commons/qr';

const ref = parseRef('sr:platform:location:loc_123'); // { app, type, id } or null

// In a subscriber's webhook route: read the raw body once, then verify.
const result = await verifyDelivery(
  { headers: request.headers, body: await request.text() },
  { secret: env.EVENTS_SUBSCRIPTION_SECRET },
);
if (!result.ok) return new Response(result.reason, { status: 401 });
// Dedupe on result.event.id, then refetch state from the owner's API.

const svg = brandedQrSvg('https://rig.sceneready.app/s/abc', { title: 'Open the rig' });
```

### Publish events with the outbox

Copy `node_modules/@scene-ready/commons/migrations/outbox/0001_outbox_event.sql` into your app's `migrations/` under your own number, once for each D1 database you write events from. A release that adds an outbox migration says so in the changelog; `OUTBOX_SCHEMA_VERSION` is the newest one. Then write the event in the same batch as the change and send it after commit:

```ts
import { newEventId } from '@scene-ready/commons/events';
import { outboxStatements, sendPending, sweepOutbox } from '@scene-ready/commons/outbox';

const event = {
  id: newEventId(),
  type: 'platform.task.closed.v1',
  time: new Date().toISOString(),
  orgid,
  subject: 'sr:platform:task:tsk_482',
  actor: userId,
  data: { status: 'closed' },
};
// Throws on an invalid event, so a bad event never commits.
await env.DB.batch([closeTask, ...outboxStatements(env.DB, event, { app: 'platform' })]);
ctx.waitUntil(sendPending(env.DB, env.EVENTS_HUB, [event]));

// In the app's cron, every few minutes:
ctx.waitUntil(sweepOutbox(env.DB, env.EVENTS_HUB));
```

Send only after `await env.DB.batch(...)` resolves, never in a `finally` or a `catch`: `sendPending` doesn't read the rows back, so it would publish an event whose change rolled back.

None of these throws because of the Hub. A rejected event stays in `outbox_event` with `rejected_at` set (find them with `listRejected`); fix the cause, then delete the row or call `resendRejected(env.DB, id)` to have the next sweep send it. An event that stays unacknowledged is logged at error level from its eighth attempt (`STUCK_AFTER_ATTEMPTS`); alert on that line. `listStuck(env.DB)` lists the same rows for an admin view, so it and the log agree on the threshold.

## What belongs here

A module belongs in commons when **two or more apps use it**, it holds **no app's domain logic**, and it holds **no state of its own** (a table it defines is the app's, in the app's database, migrated by the app; [ADR-0005](docs/adr/0005-modules-may-define-app-owned-tables.md)). Each app keeps its own bindings, secrets and configuration; nothing here reads an environment variable. Everything else stays in the app.

Planned next, each behind its own entry point: `m2m` (client-credentials tokens and API errors), `outbox/do` (the outbox for Durable Objects) and `feedback` (the feedback server helper, with the dialog at `feedback/react`, per the feedback repo's spec 002).

## Develop

```sh
npm install
npm test            # Vitest: Node, plus the fake issuer and the outbox on real D1 in workerd
npm run typecheck   # tsc over src and tests
npm run lint        # ESLint; warnings fail
npm run format      # Prettier (format:check in CI)
npm run build       # dist/, as consumers get it
```

## Release

1. In the PR, bump `version` in `package.json` and add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, grouped by entry point.
2. Merge to `main`, then run the **Release** workflow from `main`. It checks the build, tags `vX.Y.Z` and publishes a GitHub release with that changelog section.

Follow semver across the whole package: a breaking change in any entry point is a major bump. Keep breaking changes rare.
