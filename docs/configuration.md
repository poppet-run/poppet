# Configuration

[Documentation index](index.md)

## Configuration file

Save persistent settings in `<data directory>/config.json`, which defaults to
`~/.config/poppet/config.json`. The file is optional, and every field is optional:

```json
{
  "provider": "openrouter",
  "model": "replace-with-model-id",
  "notesDirectory": "notes",
  "chat": {
    "contextBytes": 262144,
    "outputTokens": 2048,
    "modelTurns": 8
  }
}
```

Explicit command arguments take precedence where supported, followed by environment
variables, file values, and built-in defaults. Environment overrides apply to individual
fields, so overriding output tokens leaves the file's other chat limits intact.

`POPPET_DATA_DIR` selects the data directory and its config file. It remains an
environment-only setting; `dataDirectory` is not accepted in the file. Missing files
use environment variables and defaults without creating anything. Unreadable files,
files larger than 64 KiB, malformed JSON, unknown keys, and wrong value types fail
with a configuration error.

Use JSON numbers for chat limits. Text must be nonempty without leading or trailing
whitespace. Relative `notesDirectory` values in the file resolve beside `config.json`.
Environment paths resolve against the current working directory. Literal `~` is
not expanded in either source.

Processes load configuration when they start. Restart a running worker after editing
the file. Configuration defaults affect new chats, messaging sessions, and tasks;
existing sessions and tasks retain their saved provider and model. Credentials and
channel settings stay in their existing protected stores.

## Settings and environment overrides

| Environment variable           | File field                | Default                  | Purpose                                                                                            |
| ------------------------------ | ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `POPPET_APP_NAME`              | `applicationName`         | `Poppet`                 | Application name used for initial ChatGPT registration                                             |
| `POPPET_DATA_DIR`              | Environment only          | `~/.config/poppet`       | Configuration, credentials, and conversation storage                                               |
| `POPPET_NOTES_DIR`             | `notesDirectory`          | `<data directory>/notes` | Notes tools' permitted directory                                                                   |
| `POPPET_PROVIDER`              | `provider`                | `openai-chatgpt`         | `openai-chatgpt`, `opencode-go`, or `openrouter`                                                   |
| `POPPET_MODEL`                 | `model`                   | Unset                    | Model ID for verification and new sessions and tasks                                               |
| `POPPET_MCP_SERVERS`           | `mcpServers`              | `[]`                     | JSON server list replacing file values; local MCP tools and scheduled permissions                  |
| `POPPET_BROWSER`               | `browser`                 | `{"enabled":false}`      | JSON object replacing browser settings, with native CLI, pinned Chromium, and allowed domains      |
| `POPPET_VOICE`                 | `voice`                   | `{"enabled":false}`      | JSON object replacing local voice settings; explicit absolute decoder, transcriber and model paths |
| `POPPET_WEB_SEARCH`            | `webSearch`               | `false`                  | Enable Brave Search when a search key is available                                                 |
| `POPPET_LOG_REASONING`         | `chat.logReasoning`       | `false`                  | Log readable provider reasoning to CLI stderr and worker logs                                      |
| `POPPET_LOG_TIMINGS`           | `chat.logTimings`         | `false`                  | Log request-stage durations to CLI stderr and worker logs                                          |
| `POPPET_CONTEXT_BYTES`         | `chat.contextBytes`       | `262144`                 | Context estimate in UTF-8 bytes, including instructions and continuation; maximum `1048576`        |
| `POPPET_HISTORY_TURNS`         | `chat.historyTurns`       | `20`                     | Previous complete exchanges sent to the model; maximum `100`                                       |
| `POPPET_OUTPUT_TOKENS`         | `chat.outputTokens`       | `2048`                   | Requested output limit when supported, capped by model metadata; maximum `32768`                   |
| `POPPET_MODEL_TURNS`           | `chat.modelTurns`         | `8`                      | Model requests per run; range `1–32`                                                               |
| `POPPET_TOOL_CALLS`            | `chat.toolCalls`          | `16`                     | Tool calls per run; range `1–64`                                                                   |
| `POPPET_TOOL_BYTES`            | `chat.toolBytes`          | `16384`                  | UTF-8 bytes per serialized tool result; range `1024–65536`                                         |
| `POPPET_SOUL_BYTES`            | `chat.soulBytes`          | `8192`                   | UTF-8 bytes in `soul.md`; range `1–65536`                                                          |
| `POPPET_PROFILE_BYTES`         | `chat.profileBytes`       | `8192`                   | UTF-8 bytes in `profile.md`; range `1–65536`                                                       |
| `POPPET_FACTS_BYTES`           | `chat.factsBytes`         | `8192`                   | UTF-8 bytes of serialized saved facts sent to the model; range `1–65536`                           |
| `POPPET_RUN_DEADLINE_SECONDS`  | `chat.runDeadlineSeconds` | `300`                    | Absolute deadline for one chat or task run; range `30–3600`                                        |
| `POPPET_TASK_CATCH_UP_MINUTES` | `tasks.catchUpMinutes`    | `60`                     | How late a missed recurring task time may still run once; `0` skips at startup; range `0–1440`     |

For a temporary override in fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start config
```

Empty or invalid environment values fail instead of falling back to the file.

The `config` command prints the invoking process's effective application settings,
all chat settings under `chat`, the config file's `path` and `exists` status under
`configFile`, and the names of ordinary settings supplied through the environment
under `environmentOverrides`. It does not inspect a running worker's settings,
create directories, open a database, or contact a provider. Credentials and secret
environment variables never appear in this output.

Chat budgets must be positive integers within the limits above. Their ranges are
validated for `config`, chat execution, worker startup, and conversation search.
Session listing and inspection work independently of out-of-range budgets.

## MCP servers

See [MCP tools](mcp.md) for server entries, selected environment and protected
credential references, separate scheduled allowlists, limits, and inspection.
Configuration contains names and references only. Restart the worker after edits.

## Browser automation

Browser automation uses an optional `browser` file section, replaced by
`POPPET_BROWSER`. It defaults to disabled. See [browser setup](browser.md) for the
pinned executables, allowed hostnames, settings, and limitations. Restart the
worker after edits. Browser tools are unavailable to scheduled runs.

## Reasoning logs

Set `chat.logReasoning` to `true` in `config.json` to show provider reasoning in
the CLI and write it to the background worker's existing
`<data directory>/logs/worker.log`. It defaults to `false`. The same setting
covers chat requests, scheduled tasks, and messaging runs. Restart the worker
after changing the file; a CLI environment override does not change a running
worker's configuration.

```json
{
  "chat": {
    "logReasoning": true
  }
}
```

For a temporary local override in fish:

```fish
set -lx POPPET_LOG_REASONING true
bun run start chat new "Review my notes"
```

`chat new` and interactive chat stream readable reasoning to stderr under a
`Thinking:` heading as chunks arrive, using muted cyan when colour is enabled.
Both local and worker-backed requests use this formatting; redirected stderr
stays readable without terminal animation. Worker logs and `chat send` diagnostics
use `Thinking` entries with session and run IDs. These diagnostic entries are buffered until
a newline, a 2048-character chunk, or the next answer/completion event; pending
text is flushed if the run fails or is interrupted. Reasoning has a separate
128 KiB limit per run. Answer stdout and messaging replies contain only answer
text. Logs may repeat private prompt or tool content and use the worker's
existing protected files and rotation.

Only readable text returned by the provider is logged. OpenAI Responses models
are asked for reasoning summaries; OpenRouter and OpenCode expose their returned
reasoning text or summaries. Availability depends on the model and provider.
Encrypted reasoning and continuation metadata are excluded. This setting does
not select a reasoning effort or token budget.

## Timing logs

Set `chat.logTimings` to `true` in `config.json` to log request durations in
milliseconds. It defaults to `false` and covers CLI, scheduled, and messaging
runs. Worker-backed CLI requests also receive the diagnostics on stderr.
Restart a running worker after changing its configuration.

For a temporary local override in fish:

```fish
set -lx POPPET_LOG_TIMINGS true
bun run start chat interactive
```

Each `Timing` entry includes a session ID, a run ID when available, and JSON with
`stage` and `durationMs`. Measured stages include memory loading, model resolution,
ChatGPT catalog lookup, MCP startup/discovery, individual model turns, tool
execution, the full run, and optional session naming. Catalog entries include
`cached`; timed operations include an `outcome` of `completed`, `failed`, or
`interrupted`. Model resolution includes authentication and catalog access. The
`first-text` duration starts when the agent begins a run and ends at its first
nonempty answer chunk, including any preceding tool turns. It excludes CLI
startup and waiting for another run's permit. Naming happens after the answer
and has its own duration; nested stage durations must not be added together.

Logs contain fixed stage labels, identifiers, durations, and outcomes. Prompts,
answers, tool arguments, credentials, and continuation state are excluded.
Answer stdout and messaging replies remain answer-only.

## API keys

API-key login saves credentials under `<POPPET_DATA_DIR>/auth/openrouter.json`
or `opencode-go.json`, with `0600` file permissions inside a `0700` directory.
Writes replace files atomically and use a separate lock for each provider.
Login reads an existing environment key if set, otherwise prompts without echo.
For scripts, `auth login openrouter --key-stdin` reads a key from standard input;
keys are never accepted as command-line arguments.

`POPPET_OPENROUTER_API_KEY` and `POPPET_OPENCODE_GO_API_KEY` override stored keys
for inference and status. Empty or invalid overrides fail instead of falling
back to a stored key. Status reports the credential source without secrets;
remote access is checked separately by verification. `auth logout openrouter`
removes that provider's saved key. It leaves other providers connected and does
not revoke the remote key or unset an environment override.

See [OpenCode Go](providers/opencode-go.md) and [OpenRouter](providers/openrouter.md) for login and model-selection examples.

## Skill files

Skills use `<POPPET_DATA_DIR>/skills/<name>/SKILL.md`. There is no separate path
setting. Each file is limited to 8192 UTF-8 bytes, and its saved text counts
against `POPPET_CONTEXT_BYTES`. Skill inspection needs only configuration;
new chats and tasks load skills in the process owning the store.
See [skills](skills.md) for naming, selection, and snapshot behavior.

## Page reading

`poppet_web.fetch_page` uses the existing model-turn, tool-call, context, and
`POPPET_TOOL_BYTES` budgets. Its 15-second overall deadline, three-redirect limit,
and 1 MiB transferred/decoded body limits are fixed. HTTP(S) uses standard ports
and direct connections; ambient proxy settings and provider credentials are not
forwarded. TLS certificate and source-hostname checks remain enabled.

## Web search

Web search uses [Brave's Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search).
Save its API key with an interactive prompt, or pipe a key to
`bun run start web login --key-stdin`:

```fish
bun run start web login
bun run start web status
```

Enable it in `<data directory>/config.json`:

```json
{
  "webSearch": true
}
```

`POPPET_WEB_SEARCH` overrides that file value. Search is disabled by default.
`POPPET_BRAVE_SEARCH_API_KEY` overrides the saved key; an empty or invalid override
fails without falling back. Login saves that environment key when present,
otherwise prompts without echo. `--key-stdin` explicitly reads stdin instead.
Keys are never accepted as command-line arguments or general configuration fields.

The existing credential store keeps the key in `auth/brave-search.json` with owner-only
permissions, separate from inference credentials. `web status` reports `enabled`,
`configured`, and credential `source` without secrets or remote requests. Missing
credentials omit the search tool while ordinary chat and page reading remain
available. `web logout` removes only the saved search key; it does not revoke the
remote key or unset an environment override. Restart an existing worker after
changing search settings or credentials. Keys are not copied into LaunchAgents.

Queries go to the fixed `https://api.search.brave.com/res/v1/web/search` endpoint
with the search key in its authentication header. Redirects are rejected.
Poppet sends the query and fixed search options, without adding conversation,
notes, profile, skills, or inference credentials as extra context. The model can
include details in its query, so review requests involving private information.
Queries and bounded source results remain in the local tool journal. Provider
reasoning logs may also contain query or result text when enabled.

Each search has a 15-second deadline, a 1 MiB response-body limit, and at most
five returned sources within `POPPET_TOOL_BYTES`. Search uses existing run budgets
and adds no browser, crawling, cache, or inference-provider fallback. See
[chat](chat.md#search-the-web) for result permissions and citations.

## Local voice transcription

Telegram voice processing stays off until configured. Install FFmpeg and
whisper.cpp's `whisper-cli`, download a compatible speech model to a permanent
local path, and add this object to `config.json` alongside your other settings:

```json
{
  "voice": {
    "enabled": true,
    "ffmpeg": "/absolute/path/to/ffmpeg",
    "whisper": "/absolute/path/to/whisper-cli",
    "model": "/absolute/path/to/ggml-tiny.bin"
  }
}
```

All three paths must be absolute; `~` is not expanded. The complete JSON object
can instead be supplied through `POPPET_VOICE`. Set `voice` to
`{"enabled":false}` to turn it off. `bun run start config` shows the invoking
process's effective voice settings. Restart the worker after changes.

Audio is downloaded from Telegram and decoded/transcribed locally. No speech
service or existing provider subscription credentials are used. Only the accepted
text transcript enters normal model inference. Transcripts and answers remain in
conversation storage after temporary audio is deleted. Voice runs require a
subsequent text confirmation for mutations. See [Telegram](gateways/telegram.md#documents-and-voice)
for limits and [the compatibility probe](attachment-probe.md) for tested versions,
installation requirements and measurements.
