# Web chat

[Documentation index](README.md)

Web chat lets you send messages, reopen saved conversations, and read replies as
they arrive. It works on desktop and mobile browsers. The worker runs the chats and
saves their history, so closing a page or signing out does not cancel a reply.

## Build and enable

From the repository root:

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

```fish
openssl rand -hex 32
```

Hash the key without putting it in shell history. Paste the resulting digest, without
its label, into `accessKeyHash`:

```fish
read --silent --prompt-str 'Access key: ' poppet_web_key
printf '%s' $poppet_web_key | openssl dgst -sha256
set --erase poppet_web_key
chmod 600 ~/.config/poppet/web.json
```

The browser accepts keys between 32 and 256 characters. The server stores only the
configured hash and compares it in constant time. Keep `web.json` owned by your user
and prevent other users from writing to it. Replace the example hash before
starting the worker.

Start or restart the worker from this checkout:

```fish
bun apps/cli/src/main.ts worker run
```

If an installed worker already owns this data directory, stop it first. Make sure its
launch command points at this checkout.
The worker prints the public web address when the listener starts.
Rebuild the app and restart the worker after frontend changes. The worker loads
assets into memory at startup.

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
`Host` header and must not buffer server-sent events. The proxy handles HTTPS; keep the HTTP backend
on loopback. You must set up DNS, certificates, and the proxy yourself. If the
listener cannot start, the worker logs why and keeps running tasks and messaging.

For same-machine development, `origin` may be `http://127.0.0.1:8080`. Poppet rejects
HTTP origins for LAN addresses or public hostnames. Remote access requires HTTPS,
which also provides the browser secure context used to create submission IDs.

Enter the original access key at the sign-in screen. Sessions use HttpOnly,
SameSite=Strict cookies, with Secure cookies for HTTPS. They expire after 12 hours
and end on sign-out or when the worker restarts. Anyone with the access key can read
and use all conversations. Changing the key hash and restarting revokes all logins.

Poppet allows ten login attempts per minute per client address. Behind a loopback
proxy, the last `X-Forwarded-For` address identifies the client. Poppet keeps at most
32 logins. Once that limit is reached, a new login replaces the oldest one.

## Conversation behavior

- Enter sends; Shift+Enter inserts a newline. Enter does not send while you are composing text with an IME.
- You can draft the next message while a reply runs. Send becomes available when it
  finishes. There is no message queue yet.
- Stop cancels a web-started run. Partial text is not saved as a completed answer.
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
- Tool permissions still apply. This UI cannot approve commands that need human
  approval. Request the operation in Discord or Slack for human approval.

The web API exposes chat operations. It does not expose provider credentials,
provider continuation data, or the worker's general command endpoint. The browser
sanitizes Markdown and removes inline images. The worker saves submission receipts
in SQLite and tracks their schema migrations separately.

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
6. Check the mobile keyboard, multiline input, sidebar, long code blocks, and sign-out.

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
