# Web chat

[Documentation index](README.md)

Web chat lets you send messages, reopen saved conversations, and read replies as
they arrive. It works on desktop and mobile browsers. The worker runs the chats and
saves their history, so closing a page or signing out does not cancel a reply.

## Build and enable

From the repository root:

Bash / Zsh:

```sh
bun install
bun run build:web
```

fish:

```fish
bun install
bun run build:web
```

Configure and sign in to a provider using the CLI first. New web conversations use
`provider` and `model` from `config.json`. Existing conversations keep their saved
provider and model. Provider credentials stay on the host.

The worker serves web chat only when `<data directory>/web.json` exists. The default
data directory is `~/.config/poppet`; set `POPPET_DATA_DIR` to use another directory.
Create `web.json` with these fields:

```json
{
  "origin": "https://chat.example.com",
  "hostname": "127.0.0.1",
  "port": 8080,
  "accessKeyHash": "replace-with-the-64-character-lowercase-sha256-hash"
}
```

Use a random access key, separate from provider credentials. Generate one locally
and save it in your password manager:

Bash / Zsh:

```sh
openssl rand -hex 32
```

fish:

```fish
openssl rand -hex 32
```

Hash the key without putting it in shell history. Paste the resulting digest, without
its label, into `accessKeyHash`:

Bash / Zsh:

```sh
printf 'Access key: ' >&2
IFS= read -rs poppet_web_key
printf '\n' >&2
printf '%s' "$poppet_web_key" | openssl dgst -sha256
unset poppet_web_key
chmod 600 ~/.config/poppet/web.json
```

fish:

```fish
read --silent --prompt-str 'Access key: ' poppet_web_key
printf '%s' "$poppet_web_key" | openssl dgst -sha256
set --erase poppet_web_key
chmod 600 ~/.config/poppet/web.json
```

The browser accepts keys between 32 and 256 characters. The server stores only the
configured hash and compares it in constant time. Keep `web.json` owned by your user
and set its mode to `0600`. Replace the example hash before
starting the worker.

Start or restart the worker from this checkout:

Bash / Zsh:

```sh
bun apps/cli/src/main.ts worker run
```

fish:

```fish
bun apps/cli/src/main.ts worker run
```

If an installed worker already owns this data directory, stop it first. Make sure its
launch command points at this checkout.
The worker prints the public web address when the listener starts.
Rebuild the app and restart the worker after frontend changes. The worker loads
assets into memory at startup. The build also writes Brotli (`.br`) and gzip (`.gz`)
copies of each asset, and the worker serves the copy the browser accepts. Bundled scripts and styles have content-hashed
names, so browsers cache them for a year; `index.html` and the API are never cached.
The proxy does not need to compress responses.

`build:web` runs the [Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli)
before bundling the page with Bun. Edit utility classes in `apps/web/src/components`
and the brand theme in `apps/web/src/styles/style.css`. The build writes generated CSS to
`apps/web/.generated` and Git ignores it. Markdown styles stay scoped in the
stylesheet because provider-generated HTML does not contain utility classes.

## Access from other devices

Put an HTTPS reverse proxy on the Poppet host in front of `127.0.0.1:8080`, with the
public address matching `origin` exactly. For example, an existing Caddy installation
can use:

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}
```

See [Caddy's reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
for streaming and header settings. Configure DNS and certificates for your hostname.
Your devices must be able to reach the proxy. The proxy must preserve the public
`Host` header and must not buffer server-sent events. The proxy handles HTTPS; `hostname` must be a loopback address (`127.0.0.1`,
`::1`, or `localhost`). You must set up DNS, certificates, and the proxy yourself. If the
listener cannot start, the worker logs why and keeps running tasks and messaging.

For same-machine development, `origin` may be `http://127.0.0.1:8080`. Poppet rejects
HTTP origins for LAN addresses or public hostnames. Remote access requires HTTPS,
which also provides the browser secure context used to create submission IDs.

Enter the original access key at the sign-in screen. Sessions use HttpOnly,
SameSite=Strict cookies, with Secure cookies for HTTPS. They expire after 12 hours
and end on sign-out or when the worker restarts. Anyone with the access key can read
and use all conversations. Changing the key hash and restarting revokes all logins.

Poppet allows ten login attempts per minute per client address and 60 per minute
across the listener. Set `"trustProxy": true` in `web.json` to use the last valid
`X-Forwarded-For` address from a loopback proxy that manages this header.
Ordinary connections have a 10-second idle timeout, and JSON bodies must arrive
within 10 seconds. Up to 32 authenticated event streams can stay open at once
(`limits.webChatStreams`), and JSON bodies are limited to 256 KiB (`limits.webChatBodyBytes`).
Poppet also keeps at most 32 logins. A new login then replaces the oldest one.

## Conversation behavior

The sidebar opens on **Chats**, which includes web and CLI conversations. Use
**Show** to see **Scheduled tasks**, a gateway such as **Slack** or **Discord**,
or **All sessions**. Each view shows the most recently active sessions first.
A task that sends its result to a gateway stays under **Scheduled tasks**.

Changing the filter keeps the open conversation and draft in place. Direct
links open sessions in any category. **+ New conversation** returns the sidebar
to **Chats**.

- Enter sends; Shift+Enter inserts a newline. Enter does not send while you are composing text with an IME.
- You can draft the next message while a reply runs. Send becomes available when it
  finishes. There is no message queue yet.
- Stop cancels a web-started run. Partial text is not saved as a completed answer.
- Delete in the conversation header removes the open conversation after you confirm.
  It is unavailable while a reply runs or the page is reconnecting. See
  [delete old sessions](chat.md#delete-old-sessions) for what else is removed.
  `DELETE /api/sessions/<id>` returns 404 for an unknown conversation and 409 while
  it has a reply in progress.
- The browser assigns each message an ID and keeps it in this tab's session storage
  until the worker confirms receipt. After a lost response, Recover submission
  uses the same ID. The worker returns its saved receipt instead of starting it again.
- Refresh or reopen a conversation URL to receive its current history and active
  reply. Reconnection never resubmits a message. Two devices can observe the same reply.
- After a worker restart, unfinished requests stay interrupted and do not run again.
  Completed answers remain saved, including when the receipt update was interrupted.
- Drafts remain in memory while navigating within the page. Refresh discards drafts
  that were never submitted. Signing out clears drafts; an unacknowledged submission
  remains in this tab for recovery after signing in again.
- Tool permissions still apply. A Bash command or reviewed MCP action that
  needs human approval stops the run. Request the operation in Discord or
  Slack for human approval.

The web API exposes chat operations. It does not expose provider credentials,
provider continuation data, or the worker's general command endpoint. The browser
renders Markdown without raw HTML: tags in a reply show as text, apart from a few
plain formatting tags such as `<br>`, `<sub>` and `<kbd>`. It drops inline images
and task-list checkboxes, keeps only `http`, `https`, `mailto` and relative links,
and opens links in a new tab. The Markdown renderer loads as a separate script after
the page starts, so a reply shows as plain text until it arrives. The worker saves submission receipts
in SQLite and tracks their schema migrations separately.

Use your browser's usual modified clicks to open a sidebar conversation in a
separate tab or window.

The event stream checks for changes twice per second. When something changes, it
sends the full conversation snapshot. Reconnecting therefore needs no replay of
earlier text updates. The page reopens the stream after a proxy error.

## Current scope and verification

Attachments, message queues, search, renaming, model and skill selection, reasoning
display, copy buttons, and run details are not available yet. Use `poppet chat show`
to inspect saved runs. A message can still
[name a skill](skills.md#name-a-skill-in-a-message) with `$name`. Web chat uses the first message as the conversation title.

`bun run check` includes the production web build, typechecking, lint,
formatting, backend lifecycle tests, and DOM tests for submission recovery and
Markdown sanitization. These tests use a controlled test provider. They do not
contact a live account.

Manual checks:

1. Sign in over HTTPS from a desktop and a phone. Send a message and compare the reply.
2. Refresh or close a page mid-reply, then reopen the same conversation on either device.
3. Draft while a reply streams, scroll up, and confirm new output does not pull you down.
4. Disconnect during submission, reconnect, and recover it. Confirm there is one input.
5. Stop a reply and inspect it with `poppet chat show`. Restart the worker during another
   reply and confirm it is interrupted without being retried.
6. Delete a conversation, confirm it leaves the sidebar on both devices, and that the
   other device shows "Conversation not found." if it had it open.
7. Check the mobile keyboard, multiline input, sidebar, long code blocks, and sign-out.

The frontend keeps chat state in Nanostores and uses `@nanostores/preact` for UI
subscriptions. The store polls the session list every five seconds while signed in.
Each mounted app has its own store; each sign-in and sign-out starts a new
generation so a late response cannot restore a signed-out session. SSE snapshots
update the store directly, and submissions are never retried automatically.

Web source is grouped under `apps/web/src`: `app/` contains the app and its DOM
tests, `api/` contains the HTTP client and shared protocol, `components/` contains
the UI components grouped into `auth/`, `chat/`, and `shared/`. Chat components
are further grouped into `sidebar/`, `transcript/`, and `composer/`, with one
component per file. `stores/` contains chat state, and `styles/` contains the
Tailwind theme and Markdown styles. `main.tsx` is the browser entry point.

If recovery keeps failing, use Forget recovery. It checks for a saved receipt first.
An existing receipt opens its conversation. A missing receipt clears this tab's
pending submission, but does not prove delivery failed or cancel a running reply.
Check history before sending the message again. If the receipt check fails,
the browser keeps the recovery ID.
