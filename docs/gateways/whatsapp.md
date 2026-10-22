# WhatsApp

[Documentation index](../index.md)

## Account setup and pairing

This adapter links a personal WhatsApp account by QR code using
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web
client. Protocol changes can break compatibility, and using an unofficial client
carries account-restriction risks. The Business Cloud API is not implemented.

Choose the account that Poppet will link and the owner whose private chat may run
it. Use international phone digits without `+`, spaces, or punctuation. A dedicated
account can reply to the owner's account. To use your own account, set both phone
numbers to your number and use WhatsApp's chat with yourself.

Select an assistant-capable provider and model, stop any running Poppet worker,
then run these commands in an interactive terminal:

```fish
bun run start gateway whatsapp setup <account-phone> <owner-phone>
bun run start gateway whatsapp pair
bun run start worker run
```

On the configured account's phone, open WhatsApp's Linked devices screen and scan
the QR. Pairing has a two-minute deadline. Poppet checks the linked account's phone
before enabling chat. A mismatch discards that pairing; run `pair` again with the
correct account. QR codes are printed only by the explicit foreground pairing
command, which rejects redirected output. They never appear in worker logs or
status. Do not share the QR or the saved authentication database.

Settings live in `<POPPET_DATA_DIR>/channels/whatsapp.json`. Signal keys and session
credentials live in `channels/whatsapp-auth.sqlite`, separate from conversation
history, with `0600` files and a `0700` directory. The database is protected by file
permissions, not encrypted at rest. Pairing and the worker share an ownership lock:
stop the worker before pairing. The SDK's key batches commit atomically; unreadable
or unwritable credentials stop the adapter rather than silently replacing keys.

Restart the worker after setup changes. `gateway status` inspects configuration
while stopped without connecting. Running status reports `connected`,
`needsPairing`, `error`, `dropped`, and `ignored`. Transient disconnects reconnect
with bounded backoff. Unlinking this device on the phone clears saved session keys
and requires pairing again. A replaced or invalid session stops for attention. Explicit pairing can reset an
invalid session once and request a fresh QR.

## Owner-only text chat

The owner has one active saved session per linked account and private chat, resumed after
worker restart. Shared conversation bindings, inbox identities, cancellation, and
reply delivery work as they do for the other adapters. `/status` reports the session
and latest run, including the selected skill and project; `/cancel` interrupts current work and cancels queued input.

Send `/new --skill weekly-review Review Acorn` to start a fresh session with a
saved [local skill](../skills.md#messaging-sessions). Add `--project acorn` to
select [project context](../projects.md), with or without a skill. Options precede
the prompt. `/new <message>` starts without either selection. Previous sessions
and history are retained. Follow-ups keep both snapshots across restart and local
file edits or deletion. Selection errors leave the active session unchanged.

Only ordinary private text from the configured owner is accepted. WhatsApp's LID
addresses must resolve through the SDK's saved phone mapping; unresolved identities
are ignored. Groups, broadcasts, edits, attachments, voice, and reactions do not
start model work. Full history synchronization is disabled. Incoming text is
limited to 8192 UTF-16 units; replies are split at 4096 units without splitting a
Unicode character. Replies are plain text with link previews disabled.

Self-chat accepts human messages sent from your own devices. Poppet records each
outgoing identity before sending, so its echoed replies cannot start another run,
including after a lost acknowledgement or restart. Those identities remain saved
when session keys are reset.

## Acceptance and delivery limits

Baileys acknowledges incoming events before exposing them to the adapter. Unlike
the Telegram polling adapter, Poppet cannot delay that acknowledgement until its
inbox commit. Receive buffering is bounded; a crash or overload before gateway
acceptance can lose an input. `dropped` counts buffer overflow during the current
worker lifetime. If an input never appears in the saved session, resend it manually.
After gateway acceptance, saved inbox identities prevent repeated model/tool work.

Completed answers are saved before sending. The SDK's automatic message retries
are disabled. Send failures and timeouts are treated as uncertain because WhatsApp
may already have accepted the reply. They do not automatically resend or rerun
inference. A successful SDK send records submission, not proof that the phone has
received or read it. Inspect `gateway status` and `chat show <session>` before
manually reposting an answer.

## Scheduled results

With `worker run` active and WhatsApp connected, select the owner's phone before
the task prompt:

```fish
bun run start tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --whatsapp-chat <owner-phone> "Summarize my notes"
```

The messaging worker validates the destination before saving. Each occurrence
keeps its linked-account and owner snapshot, then uses the shared durable delivery
queue without adding the result to the private chat's history. `tasks show` exposes
its delivery state. Choose one destination per task; WhatsApp, Telegram, and
Discord destination flags cannot be combined.

## Schedule through chat

With a tool-capable model, ask to create, inspect, pause, or resume a task in this
authorized conversation. Request delivery here to save this conversation as the
result destination after an access check. The model cannot select another chat
or identity. See [task management](../tasks.md#manage-tasks-through-chat) for time,
receipt, and recovery behavior. Scheduled runs cannot manage other tasks.

## Manual validation

Automated checks use injected sockets and temporary databases. Live QR pairing,
WhatsApp protocol compatibility, phone delivery, and model inference remain
unverified. Pair the intended account, send two owner messages, restart the worker,
and confirm the next message resumes the session. Check `/status` and `/cancel`,
rejection of another sender, and one scheduled result. For self-chat, confirm an
assistant reply does not trigger another run. Finally unlink the device on the
phone and confirm status requests pairing without reconnecting or printing a QR.
