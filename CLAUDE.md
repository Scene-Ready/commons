# commons

`@scene-ready/commons`: shared code for Scene Ready apps, one package with an entry point per module. Read `README.md` first; the rules for what belongs here are under "What belongs here" and in `docs/adr/0001-one-package-with-entry-points.md`.

```text
src/<module>/index.ts   one entry point per module, listed in package.json "exports"
tests/                  Vitest, one file per module
docs/contracts/         the API and event standards these modules enforce
docs/adr/               decisions
```

## Commands

`npm test && npm run typecheck && npm run lint && npm run format:check && npm run build`; CI runs the same.

## Rules

- **No state, no configuration.** Nothing reads environment variables, bindings or secrets; callers pass them in.
- **Runs in Workers and browsers.** Use Web Platform APIs (`crypto.subtle`, `fetch`, `TextEncoder`), never `node:` modules.
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
