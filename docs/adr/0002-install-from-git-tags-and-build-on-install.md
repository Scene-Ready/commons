---
status: accepted
---

# Install from git tags, built on install

Apps depend on a release tag, `github:Scene-Ready/commons#vX.Y.Z`. The repo holds TypeScript source only; npm runs `prepare` on a git install, which builds `dist/` with `tsc`.

The repo is public, so installs need no credentials on a developer machine, in GitHub Actions or in Claude Code cloud sessions. Building on install keeps generated files out of git.

## Considered options

- **Commit `dist/` on release tags.** Rejected: generated files in history, and a tag that forgets to rebuild ships stale code.
- **Install from the tag's tarball on `codeload.github.com`** (as Quarters installs `design-system`). Rejected for this package: npm does not run `prepare` for tarball URLs, so `dist/` would not exist.
- **GitHub Packages.** Rejected while the repo is public: it adds a token to every install for no benefit. Revisit if the package goes private.

## Consequences

- npm records git dependencies in `package-lock.json` as `git+ssh://` URLs. CI without an SSH key runs `git config --global url."https://github.com/".insteadOf ssh://git@github.com/` before `npm ci`.
- `typescript` is a dev dependency that git installs pull in to build. Keep the build to plain `tsc`.
