# Calculator compatibility probe

[Documentation index](index.md)

Stage 22a is an explicitly invoked, no-inference compatibility check for Cua
Driver 0.38.0 and macOS Calculator (`com.apple.calculator`). It is separate from
chat, workers, and configured MCP servers. It installs nothing and changes no
macOS permissions. `@poppet/computer-use` owns the probe, driver policy, lifecycle
checks, tests, and captured schemas. It reuses the compiler and scoped transport
from `@poppet/mcp`. The [Stage 22b read-only adapter](computer-use.md) is implemented
and passed its attended real-model observation. The pinned runtime cannot prove
snapshot completeness, so all references remain null. Stage 22c is explicitly
blocked and its actions remain unimplemented.

## Prepare and run

Use Apple silicon macOS, the repository's pinned Bun version, and the native
`cua-driver` executable from the
[pinned release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0).
Open exactly one Calculator window in English, basic mode, on the current Space.
Set aside its current calculation: the probe clears it and enters `12 + 7 =`.
Keep other automation away from Calculator for the duration of the trial.

Manually grant Accessibility to the launching Terminal application. Leave its
Screen Recording permission disabled, and reopen Terminal after changing grants.
An existing `CuaDriver.app` grant does not establish the direct host's permission.
The probe uses read-only permission inspection, with prompts and direct capture
probes disabled.

From the repository root:

```fish
bun --no-env-file packages/computer-use/src/test/calculator-check.ts \
  /absolute/path/to/cua-driver \
  /absolute/path/to/new-evidence-directory
```

The evidence directory must be new, absolute, and have an existing parent. It uses
mode `0700`; `report.json`, `schemas.json`, and `discovery.json` use `0600`.
Evidence contains executable/OS/app identities, original schemas, policy-file
hashes, content-free call outcomes, and the bound Calculator PID/window ID.
It excludes raw accessibility trees, tokens, images, process stderr, credentials,
and executable paths. Discovery evidence is retained when the scenario completes.

Each report covers one scenario. Exit `0` means that scenario passed; exit `1`
means blocked or pending, including an existing Screen Recording grant. Usage
errors exit `2`. Other scenarios remain explicitly listed as unperformed by that
invocation. Inspect failed evidence before a new attempt; dispatched actions with
lost responses have uncertain effects and are never automatically retried.

## What is enforced

- Verify executable size, SHA-256, code signature, signing team, and version before
  starting MCP. Compile the complete original input and discovered output schemas
  with Poppet's shared MCP compiler. Strict JSON-string wrappers retain the original
  schema rather than rewriting its token constraints.
- Start `mcp --direct`, with a private home/temp directory, fixed system path,
  telemetry opt-out, and no ambient credentials or Cua settings. A per-user desktop
  lease serializes probe instances; it does not exclude other desktop software.
- Load a five-minute bounded manifest allowing only permission inspection, fixed
  Calculator setup, window observation, token clicks, and session revocation.
  Full-desktop access stays disabled. Cua treats even filtered `list_windows` as
  desktop access, so enumeration remains denied. A fixed host-only `launch_app`
  call obtains Calculator's identity; URLs, files, arguments, other bundles, and
  session overrides are denied. The call may open Calculator if it is not running,
  but the trial still requires one prepared eligible window.
- Intersect an exact-argument Rego policy with a managed YAML session constraint.
  Rego's empty-argument discovery sentinel cannot authorize actual targetless
  calls. Both the wire click target and Cua's normalized native target are checked.
  File hashes record the supplied policies; enforcement is checked through real
  permitted and refused calls, not claimed as a remote attestation.
- Bind the returned bundle/PID to one visible window. Read at most 128 elements,
  depth 12, with a one-second native observation budget and screenshots disabled.
  Request both structured elements and accessibility tree text: the pinned driver
  omits read-only display text from its actionable element array.
- Select unique enabled `AXButton` elements supporting `AXPress`, using current
  snapshot tokens. Permit only left-button background delivery with no coordinates
  or action overrides. Reject stale tokens, capture/output paths, pixel and
  foreground variants, another app's PID, broad enumeration, and unknown tools.
  Every completed press must report the canonical `route: "accessibility"`.
  A fresh tree after each press independently supplies the exact static display
  field; the final value must be `19`.
- Reject media, unexpected capture metadata, malformed output, changed window
  identity, ambiguous buttons, and truncated/degraded observations. Discovery is
  bounded to eight pages, 128 tools, and 256 KiB. Metadata output is limited to
  256 KiB per pipe; MCP messages and cumulative stderr are each capped at 256 KiB.
  Requests have ten-second deadlines and the main trial has a five-minute limit.
- Revoke the session and verify further observation is denied. Exercise startup
  with missing manifest approval and invalid policy, stdin EOF, cancellation, and
  forced idle-owner exit. Close/reap owned processes and remove private runtime
  files before releasing the desktop lease. Leave the owner's Calculator open.

The shared compiler permits only the reviewed linear pattern
`^s[0-9a-f]{8}:[0-9]+$`. Arbitrary patterns, pattern properties, references, unknown
keywords/formats, and existing size/depth/node limits remain enforced. AJV's
`strictRequired` schema-author lint is disabled so valid required-only union
branches compile; runtime `required`, types, and extra-property checks remain
active. No schema keyword is stripped and no dependency is added.

## Manual permission scenarios

For the locked-screen scenario, use the PID and `windowId` from a successful normal
report. Enter this as one shell command, then manually lock the Mac during the
delay. Unlock after the probe has had time to finish:

```fish
sleep 10; bun --no-env-file packages/computer-use/src/test/calculator-check.ts /absolute/path/to/cua-driver /absolute/path/to/new-locked-evidence --screen-locked PID WINDOW_ID
```

This scenario sends no Calculator input or launch request. It accepts the pinned
driver's `screen_locked:` diagnostic or its explicit refusal code. It fails if
the driver does not identify the lock.

For revoked Accessibility, manually disable the launching Terminal's Accessibility
grant and reopen Terminal. Run:

```fish
bun --no-env-file packages/computer-use/src/test/calculator-check.ts /absolute/path/to/cua-driver /absolute/path/to/new-denied-evidence --accessibility-denied
```

The probe must detect the missing grant before any Calculator access or input.
Restore the grant manually afterward if desired. OS permission changes and screen
locking are never automated.

## Verified result

The three real scenarios passed on 2026-10-21, on Apple silicon macOS 27.0.1 with
Calculator 12.0 and Cua Driver 0.38.0. The owner ran the permission-sensitive checks
from Terminal with Screen Recording disabled. The normal run completed six AX
presses and read `19`; the locked-screen run reported the native lock diagnostic
without input; revoked Accessibility was detected before app access. Direct
runtime cleanup, EOF, cancellation, forced idle-owner exit, startup rejection,
stale references, and denied argument/resource variants passed.

The release asset is `cua-driver-rs-0.38.0-darwin-arm64.tar.gz`, SHA-256
`5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72`.
The executable is 80,571,376 bytes, SHA-256
`92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f`,
identifier `cua-driver`, signing team `YCK386LBJ7`. The probe verifies the supplied
executable directly; the archive checksum records release provenance. The fixture
contains original schemas from metadata and bounded MCP discovery, with no desktop
content.

Automated tests need no driver, app, permissions, or provider account:

```fish
bun run test packages/computer-use/src/calculator-check.test.ts packages/computer-use/src/calculator-runtime.test.ts packages/mcp/src/catalog.test.ts
bun run check
```

Fixtures cover the full fixed sequence, original-schema validation, malformed or
wrong-window output, media rejection, independent display readback, cancellation,
timeouts, disconnects, child reaping, and refusal to replay uncertain input. These
checks establish this attended Calculator trial only. They do not establish
general desktop automation, live-model behavior, or forced owner death during an
in-flight real desktop action.
