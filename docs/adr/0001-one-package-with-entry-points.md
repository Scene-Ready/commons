---
status: accepted
---

# One shared package with an entry point per module

Code that two or more Scene Ready apps use lives in one package, `@scene-ready/commons`, with an entry point per module (`/refs`, `/events`, `/qr`, `/qr/react`, …), not in a repo and package per module.

Apps install shared code from git tags, and npm installs only a repo's root package, so several packages would mean several repos, or a private registry with tokens in every app's CI. One repo keeps one CI setup, one release and one changelog for a solo developer. Entry points keep each app's bundle to what it imports, and optional peer dependencies (React) keep installs small.

A module belongs here when two or more apps use it, it holds no app's domain logic, and it holds no state of its own. It may define a table that the app owns, that lives in the app's database and that the app migrates ([ADR-0005](0005-modules-may-define-app-owned-tables.md)), and keep an in-memory cache of what it can fetch again ([ADR-0008](0008-oidc-claim-types-in-commons-storage-in-apps.md)). Bindings, secrets and configuration stay in each app.

## Consequences

- One version number covers every module: a breaking change in any entry point bumps the whole package (a minor release below 1.0, a major one after), so breaking changes stay rare and the changelog is grouped by entry point.
- Framework code sits behind its own entry point (`/qr/react`) over a framework-neutral core, because not every app uses React (Quarters is Vue).
- Brand tokens and assets stay in `design-system`, which changes for brand reasons on its own schedule. Its email wrappers stay there too: they run in Workers with no runtime dependencies (design-system v0.10.0), and the notifications Worker renders every email with them. Commons holds only the content apps send (`/notifications`).
- The feedback client ships here as `/feedback` (server helper) and `/feedback/react` (dialog), not in its own `Scene-Ready/feedback-client` repo. That repo was chosen before commons existed; the feedback repo's spec 002 now points here.
