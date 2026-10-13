# Anti-slop provenance

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
[`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b).

Copied `skills/install-anti-slop/assets/anti-slop/` using the upstream installer.
Verified that the bundled assets match production `src/` at that revision.
Upstream test files are excluded from the bundled distribution. Added the root
MIT `LICENSE` verbatim. The nested ESLint Stylistic licence and provenance are
retained under `vendor/eslint-stylistic/`.

Entry points:

- `tools/oxlint/anti-slop/index.ts` for generic rules.
- `tools/oxlint/anti-slop/effect/index.ts` for Effect rules.

The `no-service-constructor-imports` rule has one local change: it recognizes
`#src/` package aliases as project-local imports alongside relative paths.
The remaining rule source is unchanged. All 18 generic rules, all 5 Effect rules,
and the native `oxc/no-accumulating-spread` companion rule are enabled as errors.
Oxlint and `@oxlint/plugins` are both pinned to 1.88.0. Agent tooling directories
and this vendored directory are excluded from linting and formatting.

For updates, compare against this revision, preserve local changes, licences,
and nested provenance, and update this record after validating the integration.
