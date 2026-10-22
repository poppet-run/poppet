# Web search client

[Refactoring plans](index.md)

Depends on [Bounded I/O package](bounded-io.md).

## Implementation

Implemented. The HTTP client and transport tests live in `@poppet/agent`; the
CLI retains credential loading and commands. The client uses `readBoundedText`
from the shared `@poppet/io` package.

## Goal

Keep the Brave Search HTTP client in `@poppet/agent` next to the result parsing
it already owns. Leave only credential handling and CLI commands in the app.

## Current state

`apps/cli/src/web-search.ts` contains three things:

- `makeWebSearch`: the Brave HTTP request, status-to-error mapping, content-type
  check, bounded body read, and 15-second timeout.
- `WebSearchLive`: reads the config flag, loads the key from the environment or
  `ApiKeyStore`, and builds the service.
- `manageWebSearch`: the `web login|status|logout` commands.

`BraveSearchResponse` and `webSearchResult` are exported from `@poppet/agent`
only so this file can use them.

## Design

Move `makeWebSearch` to `packages/agent/src/web-search.ts`, using
`readBoundedText` from `@poppet/io`. `WebSearchLive` stays in the CLI because it
needs `@poppet/credentials`, which `agent` doesn't depend on.

Once moved, `BraveSearchResponse` and `webSearchResult` no longer need to be
exported from `packages/agent/src/index.ts`. Export `makeWebSearch` instead.
(`conversation.test.ts` imports `webSearchResult` through `#src`, so it doesn't
depend on the package export.)

## Steps

1. Add `@poppet/io` to `packages/agent` dependencies.
2. Move `makeWebSearch` and `maxSearchBytes` into `agent/src/web-search.ts`, and
   replace the read loop with `readBoundedText`.
3. Move the `makeWebSearch` cases from `apps/cli/src/web-search.test.ts` into
   `packages/agent/src/web-search.test.ts`. Keep the `WebSearchLive` and
   `manageWebSearch` cases in the CLI.
4. Update the `@poppet/agent` exports.

## Verification

Both `web-search.test.ts` files pass. Error reasons and messages are unchanged.
