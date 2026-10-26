# ChatGPT

[Documentation index](../README.md)

## Sign in

Sign in through the system browser, then inspect available models and connection status:

```sh
poppet provider login openai-chatgpt
poppet provider models openai-chatgpt
poppet provider status openai-chatgpt
```

## Headless and remote machines

The browser's callback goes to `127.0.0.1` on the machine running that browser.
On a server or VM, finish sign-in in a browser elsewhere and bring the callback
back in one of two ways.

**Paste the callback address.** Over SSH (`SSH_CONNECTION` or `SSH_TTY` is set),
on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, or with `--no-browser`, login
prints the sign-in link instead of opening a browser:

```sh
poppet provider login openai-chatgpt --no-browser
```

Open the link in a browser on any device and sign in. That browser then shows a
connection error for `http://127.0.0.1:<port>/auth/callback?...`. Copy the full
address from its address bar and paste it at the `Callback URL:` prompt. Poppet
checks a pasted address exactly as it checks a browser callback: it must carry
this attempt's state and use the printed callback port, and an address that
does not match is ignored so you can paste again. Sign-in still times out after
five minutes. Esc, Ctrl+C, or Ctrl+D cancels it.

**Forward the callback port.** Pin the listener port and forward it from the
machine with the browser:

```sh
ssh -L 1455:127.0.0.1:1455 <host>
poppet provider login openai-chatgpt --no-browser --callback-port 1455
```

The browser's callback then reaches Poppet through the tunnel and no paste is
needed. If the port is already in use, login fails before printing a link.

Both ways sign in on the remote machine itself, so it keeps its own host
identifier and registration, and no tokens leave it.

## Image attachments

A ChatGPT model accepts image attachments only when the account's model catalog
lists `image` among its `input_modalities`. A model without that field is treated
as text-only. This field has not been confirmed against a live catalog, so image
attachments may be unavailable for every ChatGPT model; text-file attachments
work.

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
together. An OS-held SQLite lock in `auth/owner.lock.sqlite` keeps other processes out while
one uses the credentials. Simultaneous requests within one process share the lock
and take turns reading or refreshing credentials, so an expiring token is renewed
once. `auth/owner.lock` records the current PID for diagnostics
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
