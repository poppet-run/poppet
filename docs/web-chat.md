# Web chat

[Documentation index](README.md)

The initial Preact web app uses Tailwind CSS and supports text chat, saved conversations, streamed Markdown,
mobile layouts, explicit Stop, and recovery after a lost connection. The worker owns
runs and storage. Closing a page or signing out does not cancel a reply.

## Build and enable

From the repository root:

```fish
bun install
bun run build:web
```

Configure and sign in to a provider using the CLI first. New web conversations use
`provider` and `model` from `config.json`. Existing conversations retain their saved
selection. Provider credentials never enter the browser.

The listener is disabled unless `<data directory>/web.json` exists. The default data
directory is `~/.config/poppet`; `POPPET_DATA_DIR` can select another directory.
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
and not writable by other users. The example hash placeholder intentionally fails
validation until replaced.

Start or restart the worker from this checkout:

```fish
bun apps/cli/src/main.ts worker run
```

If an installed worker already owns this data directory, stop it first. Ensure its
launch command points at this checkout before using it to serve this implementation.
The worker prints the public web address after successfully opening the listener.
Rebuild the app and restart the worker after frontend changes. Assets are loaded
into memory at startup.

`build:web` runs the [Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli)
before bundling the page with Bun. Edit utility classes in `apps/web/src/components`
and the brand theme in `apps/web/src/styles/style.css`. Generated CSS lives in
`apps/web/.generated` and is not committed. Markdown styles stay scoped in the
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

See [Caddy’s reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
for its streaming and header behavior. Configure DNS and certificate issuance for your chosen hostname. Your devices must
be able to reach that proxy. The proxy must preserve the public `Host` header and
must not buffer server-sent events. TLS terminates at the proxy; keep the HTTP backend
on loopback. Poppet does not provision DNS, certificates, a tunnel, or the proxy. If the
listener cannot start, the worker logs why and keeps running tasks and messaging.

For same-machine development, `origin` may be `http://127.0.0.1:8080`. HTTP origins
for LAN addresses or public hostnames are rejected. Remote access requires HTTPS,
which also provides the browser secure context used to create submission IDs.

Enter the original access key at the sign-in screen. Sessions use HttpOnly,
SameSite=Strict cookies, with Secure cookies for HTTPS. They expire after 12 hours,
are revoked on sign-out, and are cleared when the worker restarts. A shared key gives
owner access to all conversations; this is a single-user application. Login attempts
are limited to ten per minute per client address. Behind a loopback proxy, the last
`X-Forwarded-For` address identifies the client. At most 32 logins are retained; a new
login replaces the oldest one.
Changing the key hash and restarting revokes all existing logins.

## Conversation behavior

- Enter sends; Shift+Enter inserts a newline. IME composition does not submit.
- You can draft the next message while a reply runs. Send becomes available when it
  finishes. The initial version does not queue messages.
- Stop cancels a web-started run. Partial text is not saved as a completed answer.
- Each submission receives an ID before sending. The browser keeps an unacknowledged
  submission in this tab's session storage. After a lost response, **Recover submission**
  uses the same ID. The worker returns its saved receipt instead of starting it again.
- Refresh or reopen a conversation URL to receive its current history and active
  reply. Reconnection never resubmits a message. Two devices can observe the same reply.
- After a worker restart, unfinished requests are interrupted and never replayed.
  Completed answers remain saved, including when the receipt update was interrupted.
- Drafts remain in memory while navigating within the page. Refresh discards drafts
  that were never submitted. Signing out clears drafts; an unacknowledged submission
  remains in this tab for recovery after signing in again.
- Existing tool policies apply. Commands requiring human approval cannot be approved
  in this UI. Use the existing Discord approval path where supported.

The API exposes chat operations only. Provider continuation, credentials, and the
worker's general command endpoint are not exposed. Markdown is sanitized and remote
inline images are omitted. Web submission receipts live in the existing SQLite
store, under a separate migration ledger. SSE checks a cheap change marker twice per second and
sends a full conversation snapshot only when it changes, allowing a reconnect without
replaying text deltas. The page reopens the stream itself after a proxy error.

## Current scope and verification

Attachments, message queues, search, renaming, model/skill selection, readable reasoning,
copy controls, and a run-details panel remain follow-up work. Use `poppet chat show`
for saved run diagnostics. Automatic title generation is not invoked by web chat;
the existing fallback title is derived from the first message.

`bun run check` includes the production web build, typechecking, lint,
formatting, backend lifecycle tests, and DOM tests for submission recovery and
Markdown sanitization. These tests use a controlled provider, not a live account.

Manual acceptance path:

1. Sign in over HTTPS from a desktop and a phone. Send a message and compare the reply.
2. Refresh or close a page mid-reply, then reopen the same conversation on either device.
3. Draft while a reply streams, scroll up, and confirm new output does not pull you down.
4. Disconnect during submission, reconnect, and recover it. Confirm there is one input.
5. Stop a reply and inspect it with `poppet chat show`. Restart the worker during another
   reply and confirm it is interrupted without being retried.
6. Check the mobile keyboard, multiline input, sidebar, long code blocks, and sign-out.

The frontend keeps chat state in Nanostores and uses `@nanostores/preact` for UI
subscriptions. `@nanostores/query` handles session-list polling and chat mutations.
Each mounted app has its own stores and cache; authentication changes use a new
query key so late responses cannot restore a signed-out session. SSE snapshots
remain separate from the query cache, and mutations never automatically retry
submissions.

Web source is grouped under `apps/web/src`: `app/` contains the app and its DOM
tests, `api/` contains the HTTP client and shared protocol, `components/` contains
the UI components grouped into `auth/`, `chat/`, and `shared/`. Chat components
are further grouped into `sidebar/`, `transcript/`, and `composer/`, with one
component per file. `stores/` contains chat state, and `styles/` contains the
Tailwind theme and Markdown styles. `main.tsx` is the browser entry point.

If recovery keeps failing, **Forget recovery** checks the saved receipt first.
An existing receipt opens its conversation. A missing receipt clears this tab's
pending submission, but does not prove delivery failed or cancel a running reply.
Check history before sending the message again. If the receipt check itself fails,
the recovery identifier is retained.
