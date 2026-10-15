# Configuration

[Documentation index](index.md)

| Variable               | Default                  | Purpose                                                                                          |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `POPPET_APP_NAME`      | `Poppet`                 | Application name used for initial ChatGPT registration                                           |
| `POPPET_DATA_DIR`      | `~/.config/poppet`       | Credential and conversation storage                                                              |
| `POPPET_NOTES_DIR`     | `<data directory>/notes` | Notes tools' permitted directory                                                                 |
| `POPPET_PROVIDER`      | `openai-chatgpt`         | `openai-chatgpt`, `opencode-go`, or `openrouter`                                                 |
| `POPPET_MODEL`         | Unset                    | Explicit model ID for verification and new chat sessions                                         |
| `POPPET_CONTEXT_BYTES` | `65536`                  | Context size estimate in UTF-8 bytes, including instructions and continuation; maximum `1048576` |
| `POPPET_HISTORY_TURNS` | `20`                     | Maximum previous complete exchanges sent to the model; maximum `100`                             |
| `POPPET_OUTPUT_TOKENS` | `2048`                   | Requested output limit when supported, capped by model metadata; maximum `32768`                 |
| `POPPET_MODEL_TURNS`   | `8`                      | Maximum model requests per run; range `1–32`                                                     |
| `POPPET_TOOL_CALLS`    | `16`                     | Maximum tool calls per run; range `1–64`                                                         |
| `POPPET_TOOL_BYTES`    | `16384`                  | Maximum UTF-8 bytes per serialized tool result; range `1024–65536`                               |
| `POPPET_PROFILE_BYTES` | `8192`                   | Maximum UTF-8 bytes in `profile.md`; range `1–65536`                                             |
| `POPPET_FACTS_BYTES`   | `8192`                   | Maximum UTF-8 bytes of serialized saved facts sent to the model; range `1–65536`                 |

Paths become absolute relative to the current working directory. Explicit values
must be nonempty and have no leading or trailing whitespace. Use a full path when
configuring a directory in the environment; literal `~` is not expanded.

For example, in fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start config
```

The `config` command prints settings. It does not create directories, open a
database, or contact OpenAI. Credentials use separate protected storage and never
appear in this output.

Chat budgets must be positive integers. They are validated for chat execution;
session listing and inspection work independently of these budgets.

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
