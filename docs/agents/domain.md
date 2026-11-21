# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/contracts/`**: the API and event standards these modules enforce. Read the relevant one before changing a module that implements it. A change that moves a standard updates the contract in the same change.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-one-package-with-entry-points.md
│   │   └── 0002-install-from-git-tags-and-build-on-install.md
│   └── contracts/
│       ├── api-standard.md
│       └── event-standard.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR and contract conflicts

If your output contradicts an existing ADR or contract, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (one package with entry points), but worth reopening because…_
