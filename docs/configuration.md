# Configuration

[Documentation index](README.md)

## Configuration file

Keep ordinary settings in `~/.config/poppet/config.json`. The file and every
field are optional. To use another data directory, set `POPPET_DATA_DIR` before
running any Poppet command. Credentials stay in protected files outside this file.

A minimal configuration is:

```json
{
  "provider": "openai-chatgpt",
  "model": "replace-with-model-id"
}
```

Use `poppet provider models <provider>` to find a model ID. Login saves credentials;
it does not select a default provider or model. Existing chats and tasks keep their
saved selections when you change these defaults. Explicit command arguments take
precedence where supported.

`poppet config` validates and prints the invoking process's settings, config-file
location, and whether `POPPET_DATA_DIR` is set. It does not open storage, load
credentials, contact providers, or inspect a running worker. Restart the worker
after editing settings: `poppet worker stop`, then `poppet worker start`.

## Settings

| Field                     | Default                | Purpose                                                                           |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `provider`                | `openai-chatgpt`       | Default provider for new chats and tasks                                          |
| `model`                   | Unset                  | Required model ID for new chats and tasks                                         |
| `applicationName`         | `Poppet`               | Name used during initial ChatGPT registration                                     |
| `webSearch`               | `false`                | Enable search when the selected search provider has credentials                   |
| `webSearchProvider`       | `brave`                | `brave` or `kagi`                                                                 |
| `browser`                 | `{ "enabled": false }` | [Browser access and allowed hosts](browser.md)                                    |
| `mcpServers`              | `[]`                   | [Local servers and tool permissions](mcp.md)                                      |
| `gatewayPackages`         | `[]`                   | Explicitly installed [external gateway packages](development.md#adding-a-channel) |
| `tasks.catchUpMinutes`    | `60`                   | Missed recurring-job window, from 0 to 1440 minutes                               |
| `chat.outputTokens`       | `2048`                 | Requested output limit, from 1 to 32768, capped by model metadata                 |
| `chat.runDeadlineSeconds` | `300`                  | Overall run deadline, from 30 to 3600 seconds                                     |
| `chat.logReasoning`       | `false`                | Show readable reasoning in CLI diagnostics and worker logs                        |
| `chat.logTimings`         | `false`                | Log request-stage durations                                                       |

Context size, history length, model turns, tool calls, tool output, and memory/skill
sizes use fixed limits in code. They are not configuration fields. See
[chat limits](chat.md#context-and-run-limits). `poppet config` shows only editable
chat settings.

The file must be valid JSON, at most 64 KiB, owned by the current user, and not
writable by group or other users. Symlinks and hard links are rejected. Unknown
keys, incorrect types, and invalid values fail clearly. Text values must be
nonempty and trimmed. Relative browser command and MCP working-directory paths
resolve beside `config.json`; bare executable names use `PATH`. Literal `~` is not expanded.

## Discord

Discord continues to use `poppet gateway discord setup`. Its settings and token
are stored in the protected `channels/discord.json` file. See
[Discord setup](gateways/discord.md) for permissions and token input.

## Environment

Only `POPPET_DATA_DIR` and credential overrides configure Poppet through the
environment. Keep ordinary settings in `config.json` so terminal and
background-worker behavior agree.

Bash / POSIX sh:

```sh
export POPPET_DATA_DIR="$HOME/.local/share/poppet"
poppet config
```

fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
poppet config
```

An empty data-directory value fails. Missing config files use defaults and do not
create files. Secret overrides remain supported; empty or invalid secrets fail
instead of falling back to saved credentials. MCP child processes can still use
the environment and credential references explicitly listed in their server entries.

## Reasoning logs

Set `chat.logReasoning` to `true` to show readable reasoning in CLI diagnostics
and `<data directory>/logs/worker.log`. It covers chat, messaging, and scheduled
runs. Answer output and gateway replies contain only the answer. The provider
must return readable reasoning; encrypted continuation metadata is never logged.
Reasoning is limited to 128 KiB per run and buffered diagnostic entries are flushed
on failure or interruption. Logs can contain private prompt or tool content and
use the existing protected files and rotation. This setting does not select
reasoning effort or a reasoning-token budget.

## Timing logs

Set `chat.logTimings` to `true` to log stage durations in milliseconds. Entries
include session/run IDs and stage outcomes for model resolution, inference,
tools, naming, and the overall run. Worker-backed CLI clients also receive these
diagnostics. Nested durations overlap and must not be added together. Prompts,
answers, tool arguments, and credentials are excluded.

## API keys

API-key login saves credentials under `<POPPET_DATA_DIR>/auth/openrouter.json`
or `opencode-go.json`, with `0600` file permissions inside a `0700` directory.
Writes replace files atomically and use a separate lock for each provider.
Login reads an existing environment key if set, otherwise prompts without echo.
For scripts, `provider login openrouter --key-stdin` reads a key from standard input;
keys are never accepted as command-line arguments.

`POPPET_OPENROUTER_API_KEY` and `POPPET_OPENCODE_GO_API_KEY` override stored keys
for inference and status. Empty or invalid overrides fail instead of falling
back to a stored key. Status reports the credential source without secrets;
remote access is checked when making model requests. `provider logout openrouter`
removes that provider's saved key. It leaves other providers connected and does
not revoke the remote key or unset an environment override.

See [OpenCode Go](providers/opencode-go.md) and [OpenRouter](providers/openrouter.md) for login and model-selection examples.

## Web search

Set `webSearch` to `true` and choose `webSearchProvider`, either `brave` or `kagi`.
Then save the selected provider's key:

```sh
poppet web login
poppet web status
```

`web login --key-stdin` accepts a piped key. Credentials stay in
`auth/brave-search.json` or `auth/kagi-search.json`. `POPPET_BRAVE_SEARCH_API_KEY`
and `POPPET_KAGI_SEARCH_API_KEY` override their respective saved keys. Switching
providers preserves both keys. Logout removes only the selected saved key, without
revoking remote access or clearing an environment override. Restart the worker
after changing settings or credentials.

Queries go to the selected provider and can contain private information chosen
by the model. Keys are never sent to fetched pages. Search uses a 15-second
deadline, 1 MiB response limit, and the fixed tool-output budget. See
[web search](chat.md#search-the-web).

## Skill files

Skills live in `<POPPET_DATA_DIR>/skills/<name>/SKILL.md`, with no configurable
path. Each file is limited to 8192 UTF-8 bytes and counts against the fixed context
budget. See [skills](skills.md).

## Page reading

Page reading uses the fixed model-turn, tool-call, context, and tool-output limits.
Each request has a 15-second deadline, at most three redirects, and a 1 MiB body
limit. Only HTTP(S) standard ports are accepted. Ambient proxies and credentials
are not forwarded. See [page reading](chat.md#read-a-supplied-url).
