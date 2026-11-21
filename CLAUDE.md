# commons

`@scene-ready/commons`: shared code for Scene Ready apps, one package with an entry point per module. Read `README.md` first; the rules for what belongs here are under "What belongs here" and in `docs/adr/0001-one-package-with-entry-points.md`.

```text
src/<module>/index.ts   one entry point per module, listed in package.json "exports"
tests/                  Vitest in Node, one file per module
tests/d1/               Vitest in workerd on real D1, for modules that use it
migrations/<module>/    SQL a module ships for apps to copy (ADR 0005)
docs/contracts/         the API and event standards these modules enforce
docs/adr/               decisions
```

## Commands

`npm test && npm run typecheck && npm run lint && npm run format:check && npm run build`; CI runs the same.

## Rules

- **No state of its own, no configuration.** Nothing reads environment variables, bindings or secrets; callers pass them in. A module may define a table that the app owns, lives in the app's database and the app migrates (ADR 0005): ship it as `migrations/<module>/NNNN_*.sql`, additive only, with a version constant and a CHANGELOG line.
- **Runs in Workers and browsers.** Use Web Platform APIs (`crypto.subtle`, `fetch`, `TextEncoder`), never `node:` modules. A module built on a Workers binding (`outbox`, on D1) runs in Workers only; say so in its README row.
- **A new module** gets its own entry point in `package.json` `exports`, a test file, a `CHANGELOG.md` line and a README table row. Framework-specific code goes behind its own entry point over a framework-neutral core.
- **Breaking changes** to any entry point are a major version. Update `docs/contracts/` in the same change when a standard moves.
- **No dependency** without a reason: every app installs it. Prefer optional peer dependencies for frameworks.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Scene-Ready/commons`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` (created lazily) and `docs/adr/` at the root, plus the standards in `docs/contracts/`. Record decisions with the `domain-modeling` skill. See `docs/agents/domain.md`.
