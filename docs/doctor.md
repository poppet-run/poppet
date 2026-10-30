# Doctor

[Documentation index](README.md) · [CLI reference](cli.md)

Run `poppet doctor` to inspect local setup and get suggested next steps. Use
`poppet doctor --json` for scripts. Both forms perform the same checks and return
the same exit code.

Human output starts with a count summary and groups findings into Needs attention,
Could not check, Passed, and Skipped. Each check has a readable name, its
observation source, a wrapped explanation, and a separate next step when needed. Text wraps to the
terminal width, up to 100 columns, or 88 columns when redirected. Long paths, IDs,
and URLs remain intact.

Checks that could not finish use an UNKNOWN label and a separate "not checked"
count. They do not mean that tasks failed or messages were lost. JSON keeps its
existing status values: an incomplete check still has `incomplete: true` and
returns exit code 2. Human output uses that flag to distinguish unavailable
checks from confirmed problems.

Human output uses green for successful checks, yellow for warnings and unknown
results, red for confirmed errors, and gray for skipped checks and sources.
Redirected output and `NO_COLOR=1` use plain text. JSON output contains no styling.

Doctor reads the selected `POPPET_DATA_DIR`, or the default data directory. It
never creates a missing installation. Configuration errors do not prevent
independent filesystem and worker checks.

## Checks

| Check                | What it observes                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `installation`       | Whether the selected data directory exists                                                                                         |
| `configuration`      | Validated file settings and defaults, including chat limits and tool policies                                                      |
| `authentication`     | Selected provider's saved credential metadata or environment API-key presence, without refresh; expired access tokens are warnings |
| `worker.service`     | Service registration, which does not prove that the worker is responding                                                           |
| `worker.socket`      | Protected local socket reachability and support for doctor inspection                                                              |
| `worker.identity`    | Reported only when the worker's startup configuration differs from the CLI's configuration or the CLI configuration is invalid     |
| `tasks`              | Failures and interruptions in the last 24 hours, up to five task/occurrence IDs, omitted count, running count and next due time    |
| `provider-holds`     | Up to 20 provider IDs, saved hold reasons and retry times, with an omitted count                                                   |
| `delivery`           | Pending, failed and uncertain sends; inspect the destination before retrying uncertain sends                                       |
| `gateway.connection` | Local adapter connection observations and configuration failures, without a remote connectivity probe                              |
| `mcp`                | Enabled configuration, executable availability and scheduled-tool allowlist consistency                                            |
| `context`            | Existing `soul.md` and `profile.md` files against their UTF-8 and 8 KiB limits                                                     |

Disabled optional capabilities are skipped. An uninstalled background service is
also skipped because foreground operation is supported. An unreachable worker is
a warning: background scheduling and messaging cannot be confirmed ready.

Doctor does not run model requests, refresh tokens, start MCP servers,
send messages, install dependencies, acquire database ownership, migrate data,
restart services, or repair files. Credential permission problems are reported
without changing permissions. Suggested commands are text for you to review and
run yourself; those commands can have effects that doctor does not.

Each check has a two-second deadline. Configuration, concurrent local checks and
worker inspection run in bounded stages, within a ten-second overall budget under
normal filesystem and OS scheduling. Each platform command has an additional
1.8-second process timeout and a 64 KiB output limit. Worker responses are limited
to 32 KiB. Errors are summarized without echoing config values, credentials,
provider error bodies, messages, or tool arguments.

## Worker and offline limits

Start or restart the worker after updating Poppet to enable the `/v1/doctor`
inspection endpoint. Doctor uses its existing store connection and does not wait
for an agent execution permit. Configuration identity is captured when the worker
loads its configuration. A mismatch suppresses its saved-work summaries and
suggests checking configuration and restarting.

When a saved database exists but no compatible worker is available, doctor reports
saved-work checks as incomplete. It does not open SQLite offline: even a read-only
connection can create or change WAL/SHM sidecars. This also leaves unknown or newer
schemas untouched. If no database exists, saved-work checks are skipped.

Running work is reported without assuming it is stale. Delivery age is unavailable
because the delivery records do not store creation times. Doctor does not select
or validate a particular skill. MCP credential
validity and tool behavior, provider reachability, website login, and successful
message delivery still require explicit live use. A passing report only covers
the checks it actually performed.

## JSON contract and exit codes

Version 1 contains `version`, `dataDirectory`, `observedAt`, `exitCode`, and
`checks`. Timestamps are Unix milliseconds. Each check contains:

- `id`: stable check identifier from the table above.
- `status`: `ok`, `warning`, `error`, or `skipped`.
- `source`: `local`, `saved`, `worker`, or `not-checked`.
- `observedAt`: when the observation was collected. Worker summaries retain the
  worker's timestamp; saved credential presence is not a live provider probe.
- `message`: explanation intended for people, not a machine parsing contract.
- `nextStep`: suggested action, or `null`.
- `incomplete`: whether required inspection could not finish safely or on time.

Exit `0` means no actionable problem was found. Exit `1` means actionable warnings
or errors were found. Exit `2` takes precedence when required inspection is
incomplete. Skipped optional checks do not change the exit code. Scripts should
use `version`, `id`, `status`, and `incomplete`, not parse message text.

## Manual validation

Use a disposable data directory. Run doctor with the worker stopped, then with a
worker running from the same configuration. Check human and JSON output. Change
one config setting while the worker runs and confirm the mismatch is reported.
Then try malformed config and confirm independent checks still appear. Compare
files and permissions before and after each invocation. Doctor itself should not
launch tools, refresh credentials, create files, or perform repairs.
