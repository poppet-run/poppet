# Incoming webhooks

Incoming webhooks queue a fresh background run from an owner-configured prompt and
an external JSON event. The worker listens on `127.0.0.1` only. For remote callers,
put an HTTPS reverse proxy or tunnel in front of the webhook listener. Keep the
worker's Unix socket private.

## Configure a hook

Merge this into `config.json` in your Poppet data directory. Use a provider and
model you have already configured and authenticated:

```json
{
  "webhooks": {
    "port": 8787,
    "hooks": [
      {
        "id": "deploy-failed",
        "secretFile": "secrets/deploy-webhook.txt",
        "prompt": "Summarize the deployment failure in this event and suggest what to check next.",
        "provider": "openai-chatgpt",
        "model": "<your-configured-model>"
      }
    ]
  }
}
```

The secret file path is relative to the data directory, or absolute. Literal `~`
is not expanded. Generate a separate random token for each hook. For the default
data directory, these commands work in fish and POSIX shells:

```sh
mkdir -p ~/.config/poppet/secrets
chmod 700 ~/.config/poppet/secrets
openssl rand -hex 32 > ~/.config/poppet/secrets/deploy-webhook.txt
chmod 600 ~/.config/poppet/secrets/deploy-webhook.txt
```

The file must belong to you, be a regular file without links, and contain 32-256
printable ASCII characters. Poppet trims surrounding whitespace and makes the
file private on load. Never place the token itself in `config.json`.

Omitting `delivery` saves the result locally. To send results through a configured
messaging gateway, add a fixed destination to the hook:

```json
"delivery": {
  "adapter": "discord",
  "conversationId": "123456789012345678"
}
```

A null `conversationId` selects that gateway's configured home channel. The worker
validates the destination before accepting an event. While the gateway is
connecting or unavailable, requests for that destination return 503. Hooks with messaging delivery require the
normal worker with `poppet worker run`.
Restart the worker after editing configuration or rotating a secret. Removing
`webhooks` disables the listener after restart; already accepted tasks remain queued.

## Send an event

Start `poppet worker run`. Send a JSON object with an authentication header and a
unique event ID. This example uses fish:

```fish
set webhook_token (string trim < ~/.config/poppet/secrets/deploy-webhook.txt)
curl --request POST http://127.0.0.1:8787/v1/hooks/deploy-failed \
  --header "Authorization: Bearer $webhook_token" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: deployment-42' \
  --data '{"deployment":"42","status":"failed","service":"website"}'
set -e webhook_token
```

For POSIX shells, set the variable with
`webhook_token=$(cat ~/.config/poppet/secrets/deploy-webhook.txt)` and remove it with
`unset webhook_token`.

The response is HTTP 202 after the event and pending task commit together:

```json
{ "status": "accepted", "taskId": "<task-id>" }
```

This confirms queueing, not successful execution or delivery. Use
`poppet tasks show <task-id>` to inspect the run and its output. Provider pauses,
failures, cancellation, and explicit retries use the existing task controls.

Retry a lost request with the same event ID and identical body bytes. The response
returns `status: "duplicate"` and the original task ID, including after restart.
Changing the body for the same ID returns HTTP 409. IDs are scoped to a hook and
accept 1-128 ASCII letters, digits, periods, underscores, colons, and hyphens.
Receipts persist even when `tasks clear` removes task history, so a duplicate may
refer to a task that has since been cleared. This version does not prune receipts.

## Limits and execution policy

- Requests must contain a JSON object and be at most 6 KiB. Invalid JSON returns
  400, unsupported content types 415, and oversized requests 413.
- Missing or incorrect bearer credentials return 401. Unknown routes and methods
  return 404. Uploads are bounded by a ten-second timeout.
- At most 100 webhook tasks can be pending or running across all hooks. Further
  new events receive 429; retry later with the same event ID. Duplicate receipts
  still work when the queue is full. Storage failures return 503.
- A hook fixes its prompt, provider, model, and optional delivery destination.
  The caller cannot override those through payload fields.
- Runs start with untrusted input and use read-only built-in tools such as
  conversation lookup, page fetching, and configured web search. Bash, MCP,
  browser tools, task mutations, and memory writes are unavailable. Retries retain
  this policy. There is no per-hook tool allowlist in this version.
- Pending work survives restart. Interrupted work requires an explicit task retry;
  Poppet does not promise exactly-once external effects.

This version accepts generic bearer-authenticated JSON. Provider-specific HMAC
signatures, outgoing webhooks, event filters, receipt expiry, and rate limits beyond
the active queue cap are not included.

For a manual smoke check, send an event, inspect its completed task, resend the
identical request, and confirm it returns the same task ID. If delivery is
configured, check that one result reaches the selected channel.
