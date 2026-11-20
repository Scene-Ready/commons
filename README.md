# @scene-ready/commons

Shared code for Scene Ready apps: cross-app references, the event standard, and branded QR codes. One package with an entry point per module, so each app imports only what it uses.

| Entry point                     | What it holds                                                                         | Runs in       |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| `@scene-ready/commons/refs`     | `sr:<app>:<type>:<id>` references: `parseRef`, `formatRef`, `isRef`                   | anywhere      |
| `@scene-ready/commons/events`   | The event envelope, `validateEvent`, `newEventId`, signed delivery (`verifyDelivery`) | Workers, Node |
| `@scene-ready/commons/qr`       | Branded QR codes as data or a standalone SVG string (`brandedQrSvg`)                  | anywhere      |
| `@scene-ready/commons/qr/react` | `<QrCode>` for React apps                                                             | browser, SSR  |

The standards these modules enforce are in [`docs/contracts/`](docs/contracts/): the [API standard](docs/contracts/api-standard.md) and the [event standard](docs/contracts/event-standard.md). The overall design is the doc **Scene Ready — Cross-App Data Sharing Standard**.

## Install

Pin a release tag:

```sh
npm install github:Scene-Ready/commons#v0.1.0
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

## What belongs here

A module belongs in commons when **two or more apps use it**, it holds **no app's domain logic**, and it keeps **no state**. Each app keeps its own bindings, secrets and configuration; nothing here reads an environment variable. Everything else stays in the app.

Planned next, each behind its own entry point: `m2m` (client-credentials tokens and API errors), `outbox` (the publisher outbox for D1 and Durable Objects), `email` (email wrappers moved from `design-system`, plus sending through a `send_email` binding) and `feedback` (the feedback dialog and server helper).

## Develop

```sh
npm install
npm test            # Vitest
npm run typecheck   # tsc over src and tests
npm run lint        # ESLint; warnings fail
npm run format      # Prettier (format:check in CI)
npm run build       # dist/, as consumers get it
```

## Release

1. Add the change under a new version in `CHANGELOG.md`, grouped by entry point, and bump `version` in `package.json`.
2. Merge to `main`, then tag the merge commit `vX.Y.Z` and push the tag.

Follow semver across the whole package: a breaking change in any entry point is a major bump. Keep breaking changes rare.
