---
status: accepted
---

# One shared package with an entry point per module

Code that two or more Scene Ready apps use lives in one package, `@scene-ready/commons`, with an entry point per module (`/refs`, `/events`, `/qr`, `/qr/react`, …), not in a repo and package per module.

Apps install shared code from git tags, and npm installs only a repo's root package, so several packages would mean several repos, or a private registry with tokens in every app's CI. One repo keeps one CI setup, one release and one changelog for a solo developer. Entry points keep each app's bundle to what it imports, and optional peer dependencies (React) keep installs small.

A module belongs here when two or more apps use it, it holds no app's domain logic, and it keeps no state. Bindings, secrets and configuration stay in each app.

## Consequences

- One version number covers every module: a breaking change in any entry point is a major release, so breaking changes stay rare and the changelog is grouped by entry point.
- Framework code sits behind its own entry point (`/qr/react`) over a framework-neutral core, because not every app uses React (Quarters is Vue).
- Brand tokens and assets stay in `design-system`, which changes for brand reasons on its own schedule. Its email wrappers are planned to move here, beside sending.
- The feedback client planned as its own repo (`Scene-Ready/feedback-client`) is planned to ship here instead, as `/feedback`, which supersedes that settled decision in the feedback repo.
