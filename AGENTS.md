# Repository Guidelines

## Documentation

- Lead with the most important information and use concise, accurate prose without repetition.
- Keep package READMEs inside each package under `packages/<package>/`.
- Keep the root README's package table in sync with the actual packages under `packages/`.
- Keep package versions out of long-lived guidance and derive them from manifests.

## Code style

- Follow KISS and YAGNI; add dependencies only for current needs.
- Keep each extension as a self-contained TypeScript entrypoint without importing private details of another extension.
- Do not hardcode API keys, tokens, or other secrets in any file; read credentials from environment variables or key files.

## Package layout

- Keep every package under `packages/<package>/`.
- Give each package a `package.json` with a `pi.extensions` entry pointing at its TypeScript entrypoint.
- Declare exactly one extension entrypoint per package manifest.
- List every package entrypoint in the root `package.json` under `pi.extensions`.
- Keep `pi-macos-tools` read-only: its `skills/` directory is declared under the root `pi.skills`.

## Commands and tooling

- Run commands from the repository root unless their documentation says otherwise.
- Use `npm install` to install workspace dependencies and `npm --workspaces --if-present run typecheck` to typecheck.
- Do not introduce build tooling, test suites, or CI workflows without an explicit request.

## Git and pull requests

- Use `<type>[scope][!]: <description>` commit messages based on the actual diff, preferring `feat`, `fix`, `refactor`, or `docs`.
- Stage only intended paths, recheck the index, reject empty commits, and report the commit ID and remaining changes.
