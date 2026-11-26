# Doctor

[Engineering notes](README.md)

`poppet doctor` inspects a data directory without changing it and suggests next
steps. `--json` returns the same checks and exit code for scripts. The
[user guide](https://poppet.run/docs/doctor/) explains the report.

| Module                                    | Owns                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `apps/cli/src/commands/doctor/collect.ts` | The checks, their stages, and deadlines           |
| `apps/cli/src/commands/doctor/local.ts`   | Local filesystem and configuration observations   |
| `apps/cli/src/commands/doctor/worker.ts`  | The `/v1/doctor` worker snapshot                  |
| `apps/cli/src/commands/doctor/report.ts`  | The report types, human rendering, and exit codes |

## Rules

Doctor never runs model requests, refreshes tokens, starts MCP servers, sends
messages, takes database ownership, migrates, restarts services, creates a missing
installation, or repairs or re-permissions files. Suggested commands are text for
the owner, and running them can have effects. A configuration error does not stop
independent filesystem and worker checks. Errors are summarized without echoing
config values, credentials, provider error bodies, messages, or tool arguments.

Doctor never opens SQLite itself, because even a read-only connection can create
or change WAL and SHM sidecars and would touch an unknown or newer schema.
Saved-work checks come from the worker's `/v1/doctor` snapshot, which uses the
worker's store connection and waits for no agent slot. With a database but no
compatible worker, those checks are incomplete. With no database, they are
skipped. The worker records its configuration identity when it loads
configuration. A mismatch with the CLI suppresses the saved-work summaries and
suggests a restart.

## Checks

| Check                | Observes                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `installation`       | Whether the data directory exists                                                                                               |
| `configuration`      | Validated settings and defaults, including chat limits and tool policies                                                        |
| `authentication`     | The selected provider's saved credential metadata or environment key, without refresh. An expired access token is a warning.    |
| `worker.service`     | The service registration, which does not prove the worker answers                                                               |
| `worker.socket`      | Whether the protected socket answers and supports doctor inspection                                                             |
| `worker.identity`    | Present only when the worker's configuration differs from the CLI's, or the CLI's is invalid                                    |
| `tasks`              | Failures and interruptions in the last 24 hours, up to five IDs with an omitted count, the running count, and the next due time |
| `provider-holds`     | Up to 20 providers with hold reasons and retry times, with an omitted count                                                     |
| `delivery`           | Pending, failed, and uncertain sends                                                                                            |
| `gateway.connection` | Local gateway observations and configuration failures, without a remote probe                                                   |
| `mcp`                | Enabled configuration, executable availability, and scheduled allowlist consistency                                             |
| `context`            | `soul.md` and `profile.md` against their UTF-8 and 8 KiB limits                                                                 |

Disabled capabilities are skipped. An uninstalled service is skipped, because
foreground operation is supported. An unreachable worker is a warning. Running
work is never assumed stale. Delivery age is unknown because delivery records
have no creation time. Doctor does not check skills, MCP credential validity,
provider reachability, or live delivery.

## Deadlines

Each check has a two-second deadline. Configuration, the concurrent local checks,
and worker inspection run in bounded stages within a ten-second budget. Each
platform command has a 1.8-second process timeout and a 64 KiB output limit, and
worker responses are limited to 32 KiB.

## JSON contract

Version 1 has `version`, `dataDirectory`, `observedAt`, `exitCode`, and `checks`,
with Unix-millisecond timestamps. Each check has:

- `id`, from the table above;
- `status`: `ok`, `warning`, `error`, or `skipped`;
- `source`: `local`, `saved`, `worker`, or `not-checked`;
- `observedAt`, the worker's time for worker summaries;
- `message`, for people and not a parsing contract;
- `nextStep`, or `null`;
- `incomplete`, true when a required inspection could not finish safely or in
  time.

Exit `0` means nothing actionable. Exit `1` means warnings or errors. Exit `2`
means an incomplete required inspection and wins over `1`. Skipped checks never
change the exit code. Scripts should read `version`, `id`, `status`, and
`incomplete`.

Human output groups checks as Needs attention, Could not check, Passed, and
Skipped. An incomplete check shows as UNKNOWN, which does not mean that work
failed. Text wraps to the terminal width up to 100 columns, or 88 when
redirected, and keeps long paths, IDs, and URLs whole. `NO_COLOR` and redirected
output are plain.
