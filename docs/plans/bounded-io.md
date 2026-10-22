# Bounded I/O package

[Refactoring plans](index.md)

## Goal

Replace five copies of the bounded stream reader and two copies of the bounded
subprocess runner with one small shared package.

## Current state

Each of these reads a `ReadableStream<Uint8Array>` chunk by chunk, counts bytes,
throws past a limit, concatenates, then cancels and releases the reader in
`finally`:

| Location                                                    | Limit                 | Result            |
| ----------------------------------------------------------- | --------------------- | ----------------- |
| `packages/channel-telegram/src/api.ts` (`telegramDownload`) | attachment `maxBytes` | bytes             |
| `packages/channel-telegram/src/api.ts` (`telegramApi`)      | 2 MiB                 | UTF-8 text        |
| `apps/cli/src/web-search.ts` (`makeWebSearch`)              | 1 MiB                 | strict UTF-8 text |
| `packages/browser/src/browser-process.ts` (`readOutput`)    | 256 KiB               | strict UTF-8 text |
| `packages/gateway/src/attachment-process.ts` (`read`)       | 256 KiB               | strict UTF-8 text |

The `telegramApi` copy differs: it calls `reader.cancel()` without catching its
rejection and never calls `releaseLock()`.

`runBrowserCommand` (`browser-process.ts`) and `attachmentCommand`
(`attachment-process.ts`) both spawn a process, kill it on abort or after a
timer, drain stdout and stderr through the bounded reader, await `exited`, and
always kill and reap it. They differ only in error values and in how they judge
the exit:

- Browser: fails if timed out or aborted, or if the exit code is nonzero and
  stdout is empty.
- Attachment: separate timeout message; fails on a nonzero exit or abort. The
  launch is wrapped in `Effect.acquireRelease` so launch failures map to their
  own message.

`packages/agent/src/page-network.ts` reads a Node `IncomingMessage` with
`for await` and also decompresses. It stays out of scope.

## Design

Add `packages/io` (`@poppet/io`), scaffolded like `packages/worker`
(`package.json` with `#src/*` imports, `tsconfig.json`, `effect` only if
needed). Keep the API as plain promises so each caller keeps its own error type
and its `Effect.tryPromise` boundary:

```ts
/** Reads the whole stream, calling `tooLarge` once the running total exceeds `maxBytes`. */
export const readBounded: (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: () => unknown,
) => Promise<Uint8Array>;

/** As readBounded, then decodes strict UTF-8 (throws TypeError on invalid input). */
export const readBoundedText: (...same) => Promise<string>;

export interface BoundedRun {
  readonly stdout: string;
  readonly code: number;
  readonly expired: boolean;
  readonly aborted: boolean;
}

/** Drains both pipes under `maxBytes`, kills on abort or timeout, and always kills and reaps. */
export const runBounded: (
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  options: {
    readonly signal: AbortSignal;
    readonly timeout: number;
    readonly maxBytes: number;
    readonly tooLarge: () => unknown;
  },
) => Promise<BoundedRun>;
```

`runBounded` takes an already-launched child, so the attachment runner keeps its
`acquireRelease` launch and the browser runner keeps its injected
`BrowserLauncher`. Callers inspect `BoundedRun` and throw their own errors.

## Steps

1. Create `packages/io` with `readBounded`, `readBoundedText`, and `runBounded`,
   plus `packages/io/src/io.test.ts` covering: exact-limit success, one byte over,
   reader released after failure, invalid UTF-8, timeout kill, abort kill, and
   reaping after a limit failure.
2. Add `@poppet/io` to the dependencies of `browser`, `gateway`,
   `channel-telegram`, and `apps/cli`.
3. Replace `readOutput` and the body of `runBrowserCommand`; keep the exit rule
   in `browser-process.ts`. `startBrowserDaemon` should use `readBoundedText` for
   its pipes.
4. Replace `read` and the body of `attachmentCommand`.
5. Replace both loops in `channel-telegram/src/api.ts`. This also fixes the
   missing `releaseLock()` and the uncaught `cancel()` rejection.
6. Replace the loop in `apps/cli/src/web-search.ts` (or do this as part of
   [Web search client](web-search-client.md)).

## Verification

Existing tests should pass unchanged: `browser.test.ts`, `attachments.test.ts`,
`channel-telegram/src/channel.test.ts`, `apps/cli/src/web-search.test.ts`. Error
messages and reasons must stay identical, because tests and users see them.
