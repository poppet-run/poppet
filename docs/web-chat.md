# Web chat

[Engineering notes](README.md)

Web chat is a browser client for the worker. The worker serves the built page and
a chat-only HTTP API when `<data directory>/web.json` exists. Runs use the shared
agent, so web replies follow the same slots, budgets, and tool rules as other
chat. The [user guide](https://poppet.run/docs/web-chat/) covers setup and the
reverse proxy.

| Path                                       | Owns                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `apps/cli/src/commands/web-chat/server.ts` | The listener, authentication, assets, and API routes          |
| `apps/cli/src/commands/web-chat/chat.ts`   | Submission receipts, runs, snapshots, stop, and delete        |
| `apps/web/src/api/`                        | The HTTP client and the protocol types shared with the server |
| `apps/web/src/stores/`                     | Nanostores chat state                                         |
| `apps/web/src/components/`                 | UI in `auth/`, `chat/`, and `shared/`, one component per file |
| `apps/web/src/app/`                        | The app and its DOM tests                                     |
| `apps/web/src/styles/`                     | The Tailwind theme and Markdown styles                        |
| `apps/web/src/main.tsx`                    | The browser entry point                                       |

Chat components are grouped into `sidebar/`, `transcript/`, and `composer/`.

## Build

`bun run build:web` runs the Tailwind CLI into `apps/web/.generated`, which Git
ignores, then bundles `index.html` with Bun and writes Brotli and gzip copies of
each asset. `bun run check` includes this build. The worker loads assets into
memory at start, so frontend changes need a rebuild and a worker restart. It
serves the compressed copy the browser accepts. Hashed scripts and styles are
cached for a year. `index.html` and the API are never cached. The Markdown
renderer is a separate script that loads after the page starts.

## Settings

`web.json` must be a `0600` file owned by the Poppet user:

| Field           | Rule                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `origin`        | The exact public origin. HTTP is accepted only for a loopback origin. |
| `hostname`      | A loopback address: `127.0.0.1`, `::1`, or `localhost`.               |
| `port`          | The listener port.                                                    |
| `accessKeyHash` | The lowercase hex SHA-256 of the access key.                          |
| `trustProxy`    | Optional. Use the last valid `X-Forwarded-For` from a loopback proxy. |

Remote access needs an HTTPS reverse proxy that keeps the public `Host` header and
does not buffer server-sent events. HTTPS also gives the page the secure context
it needs to create submission IDs. If the listener cannot start, the worker logs
why and keeps running everything else.

## Listener

- The server checks `Host`, and requires `Origin` to equal `origin` on every
  non-GET request.
- The access key is 32 to 256 characters. The server compares its hash in
  constant time.
- Logins live in memory: at most 32, each for 12 hours, as HttpOnly,
  `SameSite=Strict` cookies that are `Secure` over HTTPS. A 33rd login replaces
  the oldest. Sign-out, a worker restart, or a changed hash ends them.
- Login is limited to 10 attempts per minute per client address and 60 per minute
  in total.
- Ordinary connections have a 10-second idle timeout, and JSON bodies must arrive
  within 10 seconds.
- At most 32 event streams stay open (`limits.webChatStreams`). The next one
  gets 429.
- A JSON body is at most 256 KiB (`limits.webChatBodyBytes`).

## API

| Route                                   | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `POST /api/login`, `POST /api/logout`   | Sign in and out                                                |
| `GET /api/sessions`                     | Every session, most recent first                               |
| `GET /api/session-list?source=<origin>` | Sessions with one origin, plus the gateways that have sessions |
| `POST /api/submissions`                 | Submit a message with a client ID. Returns 202.                |
| `GET /api/approvals`                    | List pending approvals across all conversations                |
| `POST /api/approvals/<id>`              | Decide an approval and return the stored outcome               |
| `GET /api/submissions/<id>`             | Read a submission receipt, or 404                              |
| `GET /api/sessions/<id>`                | A conversation snapshot                                        |
| `GET /api/sessions/<id>/events`         | Server-sent snapshots                                          |
| `POST /api/sessions/<id>/stop`          | Stop a web-started reply                                       |
| `DELETE /api/sessions/<id>`             | Delete a session. 404 if unknown, 409 while a reply runs.      |

The API never exposes credentials, continuation, or the worker socket. The
sidebar filters on `sessions.origin`, which store migration 6 added: `chat`,
`scheduled`, or `gateway:<id>`. `all` lists every origin. A
task that delivers to a gateway still counts as a scheduled session.

## Submissions and runs

The browser makes a UUID for each message and keeps it in session storage until
the worker confirms receipt. `chat.ts` saves receipts in SQLite with their own
migration ledger. Reusing an ID returns the saved receipt, and reusing it with
different input fails, so recovery after a lost response never starts a second
run. Deleting a session removes its receipts.

Accepted replies run in worker-scoped fibers and keep going after a browser
disconnects or signs out. Stop interrupts only a reply started from the web. A
worker restart preserves runs parked for approval and interrupts other unfinished
replies. A completed answer stays saved even when updating its receipt was interrupted.

When bash or a reviewed MCP action needs approval, the reply pauses. Its card
shows the request in the transcript and locks the composer. Choose **Approve
once** or **Deny**. The authenticated decision is attributed to the web access-key
holder. The card keeps its outcome across reloads. The worker resumes decided
runs after disconnects or restarts and fails requests that expire.

Web runs have no attachments or task destination context. The first message supplies the title. `$name` mentions work, because `Agent.send`
resolves them.

## Needs you

Open **Needs you** in the sidebar to see pending Bash and MCP approvals across web,
gateway, and scheduled runs. Each entry shows the source conversation, requested
action, and expiry time. Expand it to inspect the full card and choose **Approve
once** or **Deny**. Anyone signed in with the web access key can make that decision.

The open inbox refreshes every five seconds and after a decision. The first
decision wins. The original channel resumes the run and delivers its reply there.

## Event stream

`/events` checks the session's change marker twice a second. When it changes, the
server sends the whole current snapshot, so a reconnect needs no replay of
earlier deltas and never resubmits input. The page reopens the stream after a
proxy error, and two devices can watch the same reply.

## Frontend state

Chat state lives in Nanostores, with `@nanostores/preact` for subscriptions. Each
mounted app has its own store. Each sign-in and sign-out starts a new generation,
so a late response cannot restore a signed-out session. Sign-out also clears the
send state and the pending message. SSE snapshots update the store directly, and
the session list is polled every five seconds while signed in. Nothing retries a
submission by itself. Browser back and forward clear the error and the sidebar.

Forget recovery checks for a saved receipt first. A receipt opens its
conversation. A missing receipt clears the tab's pending submission, which does
not prove the message was lost. If the check fails, the tab keeps the recovery
ID.

## Rendering

`marked` renders replies with raw HTML escaped. A few plain tags such as `<br>`,
`<sub>`, and `<kbd>` survive. Inline images and task-list checkboxes are dropped.
Links keep only `http`, `https`, `mailto`, and relative targets, and open in a new
tab. Markdown styles are scoped in the stylesheet, because generated HTML has no
utility classes.

## Not supported

Attachments, a message queue, search, renaming, model and skill selection,
reasoning display, copy buttons, and run details.
