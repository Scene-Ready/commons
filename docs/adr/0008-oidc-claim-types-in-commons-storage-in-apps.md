---
status: accepted
---

# Commons owns the OIDC claim types; apps own storage; every app follows one auto-login rule

`@scene-ready/commons/oidc` (Scene-Ready/commons#30, for Scene-Ready/home#6) replaces the relying-party code each app carried. Three questions came with it: who defines the shape of auth's claims, where sign-in state lives, and what an app does when someone arrives without a session.

- **Commons owns the claim types, and auth types its claims with them.** `Identity`, `Organization`, `Entitlements`, `ProductEntitlement` and `TokenSet` live in `@scene-ready/commons/oidc/claims`, and the fields inside `urn:auth:organizations` and `urn:auth:entitlements` keep auth's wire names unchanged. Auth types the claims it issues with them (Scene-Ready/auth#193), so a change to a claim is made once and the compiler carries it to auth and every app, instead of five or six hand edits that drift. `parseIdentity` drops what it can't read: a malformed organization or product is dropped and the rest are kept, and a malformed entitlements claim means no entitlements. Unknown fields are ignored. A payload without `sub` throws. The claims are the ones home ADR 0002 (the Active Org decides the entitlements) and home ADR 0003 (JWT access tokens per resource, userinfo as the claims refresh) define.
- **Apps own storage; commons keeps only caches.** Functions take and return plain JSON: a `TokenSet` after sign-in or refresh, a pending sign-in from `startSignIn`, a `FollowRecord` from `followStep`. Commons defines no storage interface. Each app keeps its sessions and pending sign-ins wherever it already keeps state (a D1 row, a cookie it seals itself, a Durable Object). The client keeps three things in memory for the isolate's lifetime: discovery and the JWKS per client, and app-to-app tokens from `clientCredentialsToken` per audience and scopes until 60 s before they expire. Each can be fetched again, so losing it with the isolate costs one request. This narrows "no state of its own" ([ADR-0005](0005-modules-may-define-app-owned-tables.md)): a module may keep an in-memory cache of what it can fetch again; anything that has to outlive the isolate, the app stores.
- **Auto login.** Every app but portal, the launcher, follows one rule:
  - A **signed-in-only page** loaded with no session makes **one silent sign-in** (`startSignIn({ returnTo, silent: true })`, which sends `prompt=none`) and, if auth has a session, returns the person to the page they asked for.
  - The attempt is **remembered for the browser session** (a session cookie or `sessionStorage`), so the app never tries again in that browser session and can't loop between itself and auth.
  - On refusal (`not_signed_in` from `finishSignIn`), the person lands on the **app's own signed-out page**, with a sign-in button, not on auth's sign-in form. The button starts an interactive sign-in.
  - **Public pages** (share links, landing pages) never try, and neither does an **offline** app; a silent sign-in needs auth, and a public page has to work for someone with no account.

  Org follow (home ADR 0002) uses the same silent sign-in to move a session to the new Active Org.

## Considered options

- **Auth owns the claim types** and commons copies or imports them. Rejected: commons is public and depends on nothing of auth's, and every app already depends on commons; the types belong in the package both sides install.
- **A storage interface in commons** (a session store apps implement, or cookie helpers). Rejected: the apps keep state in different ways, and an interface would either fit none of them or grow an adapter per app. Sessions and sealing stay in the app.
- **Commons ships the auto-login loop guard as a helper.** Rejected for now: the guard is one flag in browser-session storage, and where that flag lives differs between a server-rendered app and an SPA (rigprep-sim). The rule is recorded here instead.
- **Sending a signed-out person straight to auth's sign-in form.** Rejected: someone opening an app from a link or the portal who isn't signed in at auth should see which app they reached and choose to sign in there.

## Consequences

- Auth can add a claim field before commons knows it, since apps ignore unknown fields. A field apps read reaches them through a commons release; renaming or removing one is a breaking change of `oidc/claims`.
- Each app's migration adds auto login, stores the `TokenSet`, pending sign-in and `FollowRecord` with its own session, and drops its own claim parser.
