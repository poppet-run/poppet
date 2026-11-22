# Poppet

A personal AI agent built with TypeScript, Bun, and Effect. Bun workspaces: `apps/cli`,
`apps/web`, and `packages/*`. See `docs/architecture.md` and `docs/development.md`.

## Commands

- `bun run check` runs format check, lint, typecheck, and tests. Run it before committing.
- `bun run test <path>` runs focused tests. Direct `bun test` is rejected.
- `bun run format` and `bun run lint:fix` apply fixes.

## Conventions

- Prefer removing code over adding code when simplifying or fixing.
- Follow the test naming and layout rules in `docs/development.md`.
- Append store migrations and raise the schema `version`. Never edit an applied migration.
- Update the matching page in `docs/` when behaviour changes. Phase plans live in
  GitHub issues.
- Commit subjects are plain imperative sentences that describe the behaviour, such as
  "Let a recurring task carry an end time". Use one commit per fix.
