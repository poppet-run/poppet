# ChatGPT

[Documentation index](../README.md)

## Sign in

Sign in through the system browser, then inspect available models and connection status:

```sh
poppet provider login openai-chatgpt
poppet provider models openai-chatgpt
poppet provider status openai-chatgpt
```

## Registration and consent

Initial sign-in registers Poppet with its own host identifier and issued client
ID. The browser handles account and workspace selection and plan-usage consent.
The local callback displays a confirmation page before its listener closes.
Return to the terminal for the final identity and permission checks.
Later sign-ins reuse the registration and host identifier until logout. The next
login after logout creates a fresh registration and host identifier. Poppet currently stores
one account and rejects a returning identity that does not match it until logout.
[OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

If identity sign-in succeeds without plan-usage permission, status reports
`planUsage: false`. Run `poppet provider login openai-chatgpt` again. Login automatically
requests consent when saved credentials lack plan-usage permission. Returning
sign-ins with plan permission do not force another consent prompt. Usage limits,
ineligible accounts, temporary failures, and interrupted streams produce separate errors. Model requests are not automatically retried.
The flow uses OAuth credentials and requires no API key or client secret.

Model resolution reuses a successful catalog lookup for up to one minute within
the same process, including across interactive CLI turns and worker requests.
Each lookup still checks current authentication. Credential changes, an expired
entry, or a model absent from the cached catalog trigger a fresh request.
`provider models` always fetches a fresh catalog. Failed responses
are not cached, and nothing is written to disk. Separate one-shot CLI processes
do not share the cache. Enable [timing logs](../configuration.md#timing-logs) to
see catalog hits and misses.

## Credential storage

Credentials live in `<POPPET_DATA_DIR>/auth/connection.json`, with owner-only file
permissions (`0600`) inside a protected directory (`0700`). Writes use atomic
replacement. Tokens are redacted in application values and omitted from command
output. Near-expiry access tokens are refreshed with rotating credentials saved
together. An OS-held SQLite lock in `auth/owner.lock.sqlite` prevents concurrent
authentication commands. `auth/owner.lock` records the current PID for diagnostics
and is removed on normal shutdown or interruption. After a crash, the OS releases
the SQLite lock and the next owner replaces the leftover PID marker automatically.
Never remove the lock database while Poppet is running.

## Logout

`poppet provider logout openai-chatgpt` deletes the saved connection file,
including account identity, tokens, verification, registration, and host identifier,
then attempts remote revocation. Status does not recreate those details.
Other providers' credentials are preserved. If remote revocation cannot
be confirmed, the command reports this so you can disconnect Poppet in ChatGPT
Settings.

See [provider selection](../cli.md#providers-and-models) for configuring inference and [chat](../chat.md) for saved sessions.
