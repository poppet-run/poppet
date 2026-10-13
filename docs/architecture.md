# Poppet architecture

Start with one local process invoked by the CLI. Add a background worker when
scheduled tasks need one. The first chat flow calls the runner directly.

## Effect conventions

Use `Effect<A, E, R>` for operations with I/O, expected failures, cancellation, or
dependencies. Keep pure transformations as ordinary TypeScript functions.

- Define external capabilities with `Context.Service` and provide implementations
  with `Layer`. `AppConfig` is the first example. Add services when a capability
  needs injection or resource ownership.
- Validate configuration, tool arguments, and external records with Effect
  Schema. Keep expected failures in the typed error channel and distinguish them
  from defects.
- Compose operations with `Effect.gen`. Execute Effects at the process boundary
  in `main.ts` and in tests. Keep `runPromise` out of application services.
- Acquire database connections, listeners, and other resources in scoped layers
  with finalizers. `BunRuntime.runMain` owns process interruption and shutdown.
- Adapt Promise APIs with `Effect.tryPromise` and pass its `AbortSignal` to APIs
  that support cancellation. Apply local deadlines to model requests and tools.
- Apply retry policies only to operations known to be safe to repeat. Use Effect
  `Schedule` for bounded retries and polling, and a controllable clock in tests.

The Bun platform adapter is pinned alongside Effect. Its API is marked unstable
in Effect 4, so dependency upgrades must include the CLI checks.

## Planned modules

| Module         | Responsibility                                                   | Dependencies                                                |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `config.ts`    | Validate settings and provide `AppConfig`                        | Effect Config and Schema                                    |
| `auth.ts`      | Registration, sign-in, protected credentials, serialized refresh | Configuration, scoped callback listener, credential storage |
| `model.ts`     | Model discovery, streamed inference, normalized errors           | Authentication, OpenAI client                               |
| `store.ts`     | SQLite migrations, sessions, messages, runs, facts, jobs         | Configuration, scoped Bun SQLite connection                 |
| `agent.ts`     | Bounded conversation context and sequential tool loop            | Model, store, memory, tools                                 |
| `tools.ts`     | Validated tool definitions and execution policies                | Schema, scoped filesystem access                            |
| `memory.ts`    | Editable profile and explicitly saved facts                      | Store, configuration                                        |
| `scheduler.ts` | Persisted due occurrences and sequential worker                  | Store, agent, clock, occurrence calculator                  |
| `cli.ts`       | Typed commands and terminal presentation                         | Application services required by each command               |

Each live service gets a layer at the application boundary. Tests replace model,
authentication, and clock behavior without contacting an account. SQLite and
filesystem tests use temporary directories.

## Data and execution rules

SQLite owns durable records. An Effect queue can wake a worker, but it does not
replace persisted pending runs or task occurrences. A single owner executes runs
and refreshes credentials; a background process will require a lock and protected
local communication before it shares data with a CLI client.

Store structured model messages, tool requests, and tool results. Trimming context
must preserve complete exchanges and tool request/result pairs. Limit loaded
memory, tool output, model turns, and tool calls. Stop clearly when the active
exchange alone exceeds the context budget.

Keep credentials separate from notes, memory, and tool-readable files. Limit tools
to the configured notes directory, including resolved symlink targets. The runner
enforces allowed tools before invoking them. Scheduled runs begin with read-only
tools.

Do not automatically retry a side effect whose completion is uncertain. Record
its state and require an explicit retry. Note writes use atomic replacement;
database updates use transactions. Exactly-once external execution is not assumed.

## Dependencies

The foundation uses Effect 4.0.4, its Bun platform adapter, TypeScript 7.0.2,
Oxfmt 0.73.0, Oxlint 1.88.0, and Bun 1.3.14 with matching Bun types. Versions are
pinned and the lockfile is checked in. Effect provides Config and Schema, so a separate schema
library is unnecessary.

Introduce the OpenAI client and sign-in reference dependencies during subscription
verification. Add an occurrence calculator only when persisted schedules need it.
Assess Effect's cron support then; timezone and downtime behavior must pass the
same tests whichever calculator is chosen.

References: [Effect installation](https://effect.website/docs/v4/getting-started/installation),
[services](https://effect.website/docs/v4/requirements-management/services),
[configuration](https://effect.website/docs/v4/configuration), and
[process runtime](https://effect.website/docs/v4/platform/runtime).
