# AGENTS.md

## Repo overview

This repository contains `pi-cmux`, a small Pi package that adds cmux-powered terminal workflows to Pi.

Current extensions:
- `extensions/cmux-notify.ts` — sends `cmux notify` alerts when Pi finishes, waits for input, or ends in an error/abort state
- `extensions/cmux-split.ts` — adds split commands that open a new cmux pane and start a fresh Pi session in the same working directory
- `extensions/cmux-zoxide.ts` — adds zoxide-based split commands that jump to a matched directory and start Pi there

Other important files:
- `README.md` — user-facing package documentation
- `CHANGELOG.md` — unreleased and released changes
- `install.mjs` — installer/removal entrypoint used by `npx pi-cmux`
- `package.json` — package metadata for npm and Pi

## How the repo works

- This is a TypeScript-based Pi package with a local TypeScript toolchain (`npm run typecheck`) and CLI regression tests (`npm test`), but no build step.
- Extensions are loaded from `./extensions` via the `pi.extensions` entry in `package.json`.
- The package is published to npm and installed in Pi via `pi install npm:pi-cmux` or `npx pi-cmux`.

## Editing guidelines

- Keep README examples and behavior descriptions aligned with the extension behavior.
- Update `CHANGELOG.md` for user-visible changes.
- Prefer small, focused edits.
- Preserve the existing style: concise docs, simple utilities, minimal dependencies.

## Release / push checklist

Before pushing changes:
- update `CHANGELOG.md` if behavior changed
- make sure `README.md` matches the current behavior
- review the git diff for accidental changes

## Notes for future agents

- Use `npm ci --ignore-scripts` to install the pinned development dependencies. Run `npm run typecheck`, `npm test`, and `npm run pack:check` before pushing.
- Dependabot checks for Pi updates weekly. Keep the development version and lockfile pinned, and review the minimum supported Pi version before using newer APIs or CLI flags.
- If you change publishable package metadata or release behavior, check `package.json`, `package-lock.json`, `README.md`, and `CHANGELOG.md` together.
