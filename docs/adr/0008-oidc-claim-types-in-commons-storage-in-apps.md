---
status: accepted
---

# Commons owns the OIDC claim types; apps own storage; apps sign in silently

`@scene-ready/commons/oidc` (Scene-Ready/commons#30) replaces the relying-party code each app carried (Scene-Ready/home#6). Three questions came with it: who defines the shape of auth's claims, where sign-in state lives, and what an app does when someone arrives without a session.

## Decision

- **Commons owns the claim types, and auth types its claims with them.** `Identity`, `Organization`, `Entitlements` and `TokenSet` live in `@scene-ready/commons/oidc/claims`, under auth's wire names unchanged. auth types the claims it puts in ID tokens, access tokens and userinfo with them (Scene-Ready/auth#193), so a change to a claim is one commons release that the compiler then carries to auth and every app, not five or six hand edits that drift. `parseIdentity` fails closed per product: a malformed product entitlement is dropped and the rest are kept; unknown fields are ignored, so auth can add a field before apps upgrade. The claims are the ones home [ADR 0002][home-0002] (the Active Org decides the entitlements) and home [ADR 0003][home-0003] (JWT access tokens per resource, userinfo as the claims refresh) define.
- **Commons stores nothing but the app-to-app token cache.** Functions take and return plain JSON: a `TokenSet` after sign-in or refresh, a pending sign-in from `startSignIn`, a `FollowRecord` from `followStep`. Commons defines no storage interface. Each app keeps its sessions and pending sign-ins wherever it already keeps state (a D1 row, a cookie it seals itself, a Durable Object). A pending sign-in holds the PKCE verifier, so the app keeps it where the browser can't read or change it. The one exception is `clientCredentialsToken`, which keeps app-to-app tokens in memory per audience until 60 s before they expire; they belong to the app, not a person, and losing them with the isolate costs one token request.
- **Auto login.** Every app but portal, the launcher, follows one rule:
  - A **signed-in-only page** loaded with no session tries **one silent sign-in** (`startSignIn({ returnTo, silent: true })`, which sends `prompt=none`) and, if auth has a session, returns the person to the page they asked for.
  - The attempt is **remembered for the browser session** (a session cookie or `sessionStorage`), so the app never tries again in that browser session and can't loop between itself and auth.
  - On refusal (`not_signed_in` from `finishSignIn`), the person lands on the **app's own signed-out page**, with a sign-in button, not on auth's sign-in form. The button starts a normal, interactive sign-in.
  - **Public pages** (share links, landing pages) never try, and neither does an **offline** app; a silent sign-in needs auth, and a public page has to work for someone with no account.

  Org follow (home ADR 0002) uses the same silent sign-in to move a session to the new Active Org.

## Considered options

- **Auth owns the claim types** and commons copies or imports them. Rejected: commons is public and depends on nothing of auth's, and every app already depends on commons; the types belong in the package both sides install.
- **A storage interface in commons** (a session store apps implement, or cookie helpers). Rejected: the apps keep state in four different ways, and an interface would either fit none of them or grow an adapter per app. Sessions and sealing stay in the app; commons keeps "no state of its own" (ADR-0005).
- **Commons ships the auto-login loop guard as a helper.** Rejected for now: the guard is one flag in browser-session storage, and where that flag lives differs between a server-rendered app and an SPA (rigprep-sim). The rule is recorded here instead.
- **Sending a signed-out person straight to auth's sign-in form**, as some apps did. Rejected: someone opening an app from a link or the portal who isn't signed in at auth should see which app they reached and choose to sign in there.

## Consequences

- A change to a claim is a commons release first, then auth, then the apps (the merge order in Scene-Ready/home#6). A breaking change to a claim type is a major version of commons.
- Each app migration (Scene-Ready/home#6) adds auto login, stores the `TokenSet`, pending sign-in and `FollowRecord` with its own session, and drops its own claim parser.

[home-0002]: https://github.com/Scene-Ready/home/blob/main/docs/adr/0002-org-follow.md
[home-0003]: https://github.com/Scene-Ready/home/blob/main/docs/adr/0003-access-tokens-and-claims-refresh.md
