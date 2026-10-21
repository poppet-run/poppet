# Read-only Calculator trial

[Documentation index](index.md)

Stage 22b lets a tool-capable text model observe one owner-prepared macOS
Calculator window through accessibility. The only tool is
`poppet_computer.snapshot`, which accepts `{}`. It cannot launch Calculator,
press buttons, type, capture images, or select another target. Stage 22c actions
remain unimplemented.

`@poppet/computer-use` owns settings, the fixed window binding, driver policy,
process lifetime, and normalization. It reuses the existing MCP transport and
schema compiler without weakening their validation. Fixture tests and the
attended real-model observation passed. See the [verified live trial](#verified-live-trial)
for its scope and remaining action-reference limitation.

On 2026-10-21 the pinned native startup, bounded three-tool discovery, original
schema checks, and session cleanup also passed a permission-only check. That
check correctly refused the Codex host's permissions before any window read;
it did not run inference or establish live observation behavior.

## Prepare the trial

Use Apple silicon macOS and the checksum-verified native Cua Driver **0.38.0**
from the [Stage 22a compatibility probe](computer-use-probe.md). Poppet verifies
the executable's size, SHA-256, version, code signature, signing team, and
identifier before starting a directly owned `mcp --direct` process. It never
installs or upgrades the driver or attaches to a shared daemon.

Manually open one English, basic-mode Calculator window on the current Space.
Keep the Mac unlocked and other automation away from Calculator. Supply its
current PID and window ID yourself. A completed 22a report contains these values;
they cease to be valid if the app/window is replaced. This stage performs no app
launch or window enumeration to find a replacement.

In System Settings, grant Accessibility to the launching Terminal application
and leave Screen Recording disabled. Reopen Terminal after changing grants.
Poppet checks permissions without prompts or direct-capture probes, before
observation begins and before every snapshot. A shared daemon's grant is
insufficient. Permission changes and locking the screen stay manual.

Use a separate `POPPET_DATA_DIR` with empty soul, profile, memory facts, and notes;
no configured channels or scheduled tasks; and browser, MCP, and search disabled.
Authenticate a provider normally in this directory using the
[provider setup guide](getting-started.md#connect-a-provider). Choose a
tool-capable assistant model. Do not copy private notes or channel credentials
into the trial directory.

Add this section to its `config.json`, alongside the provider and model:

```json
{
  "computer": {
    "enabled": true,
    "command": "/absolute/path/to/cua-driver"
  }
}
```

Access defaults to disabled. `POPPET_COMPUTER` replaces this complete section;
`{"enabled":false}` disables it. Unknown fields, relative commands, and an
enabled section without a command fail validation. The `config` command displays
effective settings without starting a driver or reading the desktop.

## Run and inspect

From the repository root in that Terminal, replacing the example paths and
target numbers with the prepared values:

```fish
set -lx POPPET_DATA_DIR /absolute/path/to/disposable-trial-data
bun run start config
bun run start chat new --computer --computer-target 12345:67890 \
  "Read Calculator's display and list the available arithmetic buttons. Do not perform a calculation."
```

Both flags must precede the message. The target belongs to this host request;
the model cannot change it through tool arguments. A changed PID/window or a
missing/ambiguous display stops the trial without rebinding. The pinned parser
requires an English basic-mode display.

The opt-in applies only to this fresh, standalone assistant run. Ordinary chats,
resumed sessions, interactive chat, workers, messaging, scheduled runs, and title
generation receive no computer tools. Worker request schemas reject forged
permits. If a worker endpoint exists in the selected data directory, the CLI
rejects the trial before routing or opening the store. Stop that worker or use
separate trial storage. `--coding` and `--skill` cannot accompany this trial.

Copy the session ID printed to stderr, then inspect the durable records:

```fish
bun run start chat show SESSION_ID
```

Confirm the answer matches the actual display and buttons. Calls should have
`serverId: "computer"`, `toolName: "snapshot"`, empty arguments, and normalized
JSON output. Each observation includes a fresh `snapshotId`, app/window identity,
element references, roles, labels, values, enabled state, supported AX actions,
and `truncated`. Native tokens, geometry, raw tree text, and images are excluded.
Supported AX actions are descriptive; no action tool exists. Partial or
host-truncated observations contain no usable references.
The native contract can omit `truncated` and may not prove tree completeness.
Such observations remain readable but are marked truncated with null references.

These observations remain in normal chat history under its existing retention
rules. Removing private runtime files does not delete saved accessibility text.
Use disposable Calculator content. Prompt injection in app text cannot add
tools: the trial offers no note, memory, task, page, browser, or general MCP tools.

## Bounds and cleanup

The native manifest allows only permission inspection, fixed screenshot-free
window observation, and session revocation. Its Calculator resource restriction
intersects an exact-argument policy and a required host session. Desktop capture,
launch, enumeration, and input tools are denied before dispatch.

One run owns one direct child and a per-user desktop lease shared with the 22a
probe, including across data directories. A competing Poppet trial fails busy.
The lease cannot exclude the owner or unrelated automation.

Runtime directories use mode `0700`, files `0600`, and a minimal child environment
without provider/channel secrets or ambient Cua settings. Startup has an
eight-second deadline, each native call ten seconds, and the runtime at most five
minutes without renewal. Trees request at most 128 elements, depth 12, and a
one-second walk. Protocol messages and cumulative stderr are capped at 256 KiB;
model arguments at 64 KiB. Normalized results fit the existing `chat.toolBytes`
budget as valid JSON with intact Unicode. Global chat budgets are unchanged.

Completion, failure, cancellation, and deadline expiry close and reap the owned
child and remove private files before releasing the lease. Session revocation is
attempted when the connection remains usable. Cleanup failure is reported.
Calculator stays open. Interrupted dispatched calls remain uncertain in the
existing durable records; no request is automatically replayed or reconnected.

Enable `chat.logTimings` to record `computer-startup`, `computer-snapshot`, and
`computer-cleanup` through the existing timing logger. Timing output is evidence
for that run, not a performance guarantee.

## Verified live trial

The attended read-only check passed on 2026-10-21 with `openai-chatgpt` and
`gpt-6.1-sol`, Cua Driver 0.38.0, macOS 27.0.1 on Apple silicon, and Calculator
12.0. The owner ran the CLI from Terminal with Accessibility enabled and Screen
Recording disabled, using separate authenticated trial storage and an
owner-supplied PID/window binding.

The saved run contained exactly one completed `computer/snapshot` call with
`{}` arguments. Its normalized result contained 35 elements in 4,155 UTF-8
bytes. The model reported the existing display, last expression, and arithmetic
buttons. The owner confirmed those matched the actual app and the display stayed
unchanged. No calculation or input action was requested or performed.

Inspection of the loaded manifest, exact target policy, and session constraint
confirmed screenshot-free observation with launch, capture, and input denied.
The owned driver exited, its private runtime directory was removed, and the
desktop lease was released. A separate ordinary chat completed without tool
calls or computer startup timing stages. Normalized observations and trial
authentication remain in private trial storage; no private evidence is committed.

Single-run timings were 153 ms for driver startup, 347 ms for the snapshot, and
13 ms for cleanup. The observation run took 9,066 ms, followed by a separate
3,118 ms title request. These are measurements from this trial, not performance
guarantees.

The snapshot was marked truncated and every reference was null because tree
completeness was unproven. The model correctly reported this limitation. This
passes read-only observation; it does not establish action readiness. Stage 22c
must resolve completeness and safe reference issuance before adding presses,
while preserving validation and the prohibition on references from incomplete
observations. No Stage 22c action behavior was exercised.
