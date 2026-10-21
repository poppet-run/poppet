# Telegram

[Documentation index](../index.md)

## Bot setup

Create a bot through [BotFather](https://core.telegram.org/bots/features#creating-a-new-bot).
Keep its token private. The bot ID is the numeric prefix before the token's colon.
Use your numeric Telegram user ID as the owner ID. This adapter accepts ordinary
text and single supported attachments only in the private chat between that owner and the bot.

Select an assistant-capable provider and model, then save the token through stdin:

```fish
read --silent --prompt-str 'Telegram bot token: ' telegram_token
printf '%s\n' $telegram_token | bun run start gateway telegram setup <bot-id> <owner-id> --key-stdin
set -e telegram_token
bun run start gateway work
```

Replace the placeholders with numeric IDs. Open the bot's private chat in Telegram,
press Start if needed, and send a text message. Settings and the redacted token live
in `<POPPET_DATA_DIR>/channels/telegram.json`, protected with `0600` file and `0700`
directory permissions. Restart an existing worker after changing settings.
`gateway status` can inspect saved configuration while stopped without connecting.

Use this bot with one polling client. An existing webhook or another client
polling the same token can prevent reception. Poppet reports the conflict in
channel status; it does not delete webhooks or discard pending updates.

## Conversations and controls

The owner has one active saved session per bot and private chat. It resumes after worker
restart and retains its selected provider and model. Telegram and Discord have
separate sessions even if external IDs happen to match.

Send `/new --skill weekly-review Review Acorn` to start a fresh session with a
saved [local skill](../skills.md#messaging-sessions). `/new <message>` starts without
a skill. Both retain previous sessions and history; ordinary follow-ups keep the
active session's snapshot across restart and local file edits.

After the first exchange, `/status` reports the session, skill, and latest run. `/cancel`
interrupts active work and cancels queued input in this chat without waiting for
inference. The adapter sends typing actions while processing and plain text
replies, split at 4096 UTF-16 units without splitting a Unicode character.
Formatting syntax is sent literally, and link previews are disabled.

Other users, groups, channels, topic messages, and edited messages are deliberately
ignored. Unsupported attachments from the owner receive a clear reply. Reactions
and Telegram chat renaming remain outside this adapter's scope.

## Documents and voice

Send one UTF-8 `.txt`, `.md`, `.markdown`, or text-based `.pdf` file. Its caption
is your request; without a caption Poppet gives a short summary. PDF replies state
extraction completeness and retain page labels for citations. Scans, encrypted or
malformed PDFs, images, archives, albums, forwarded attachments and remote file
links are unsupported. Send files directly so a third-party caption cannot act as
your current instruction.

Text downloads are limited to 64 KiB, with at most 32 KiB of accepted text. PDFs
are limited to 8 MiB, 64 pages and 30 seconds of extraction. PDF text can be
excerpted at 32 KiB; the reply and model input explicitly identify omitted text
and pages. Oversized text files are rejected rather than shortened. Combined
caption, source, instructions and tools must still fit the configured chat budget.

Attachment contents and links are untrusted source material. They cannot grant
URL access or authorize note, memory or task changes. A separate caption can
request an action under the ordinary chat rules. `/new`, `/status` and `/cancel`
are parsed only from your text/caption. File contents cannot invoke them.

Voice is optional and disabled by default. Configure
[local transcription](../configuration.md#local-voice-transcription), then restart
the worker. Telegram Ogg/Opus voice messages must be at most 8 MiB and 2 minutes;
accepted transcripts are at most 16 KiB. Audio decoding and transcription stay
on your machine. The transcript is sent to the selected text model.

Every voice reply shows the exact accepted transcript. Voice runs have no note,
memory or task write tools and no external MCP/browser tools. For a dictated
reminder, Poppet proposes the task and resolved time/timezone, then asks you to
confirm in a subsequent text message. Correct unclear words or times before
confirming; speech recognition does not authenticate a speaker.

Downloads and extraction run before inference without holding the model permit.
Accepted text is saved before the run starts, so restart or repeated updates reuse
it. Raw files are removed after processing; startup removes only this feature's
abandoned temporary directories. Saved text, transcripts, source metadata and
answers remain in conversation storage and may enter provider history. Removing
temporary files does not erase those records or any earlier tool effects.
Reasoning diagnostics are suppressed for attachment runs and later turns in a
session containing attachment source records.

## Polling and delivery

The adapter uses the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)
with long polling. Each accepted input commits to the gateway inbox before its
next polling offset is saved. Deliberately ignored updates also advance the
offset. Polls request up to ten updates to keep batches within the two MiB response
limit. When the 64-request inbox is full, excess requests are saved as rejected
with a queue-full reply before advancing the offset. Retry those requests later;
`/status` and `/cancel` remain reachable while the inbox is full.

Offsets are stored separately for every adapter and bot account. A crash
between acceptance and offset persistence can redeliver an update; inbox
identities prevent repeating model or tool work.

Completed answers are saved before sending. Explicit rate-limit rejections use
the server's retry delay and the gateway's bounded retry policy. Network failures,
server failures, malformed send responses, or lost acknowledgements can leave a
send uncertain. Poppet retains that state without resending automatically.
Inspect `gateway status` and the saved session with `chat show <session>` before
manually reposting an answer. A failed delivery does not rerun inference.

## Scheduled results

Run `bun run start worker run` to enable scheduling and messaging together, then
select the configured owner's private chat before the prompt:

```fish
bun run start tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --telegram-chat <owner-id> "Summarize my notes"
```

The messaging worker checks the destination before saving. Each occurrence keeps
its bot, owner, and chat snapshot. Results use the shared durable delivery queue
and remain separate from the private chat's conversation history. `tasks show`
includes the snapshot and delivery states. Choose one destination per task;
`--telegram-chat`, `--whatsapp-chat`, and `--discord-thread` cannot be combined.

## Schedule through chat

With a tool-capable model, ask to create, inspect, pause, or resume a task in this
authorized conversation. Request delivery here to save this conversation as the
result destination after an access check. The model cannot select another chat
or identity. See [task management](../tasks.md#manage-tasks-through-chat) for time,
receipt, and recovery behavior. Scheduled runs cannot manage other tasks.

## Manual validation

Send a small Markdown file with and without a caption, a two-page PDF, and an
unsupported file. Check grounding, page/omission labels, and clear rejections.
Cancel during extraction, restart after an accepted file, and confirm no duplicate
answer. After enabling local voice, send a short question and a dictated reminder;
verify the displayed words and proposed timezone, confirm by text, and check that
exactly one task is created. Check another sender cannot trigger any download.

Automated tests use injected HTTP replies and temporary SQLite databases. Live
bot setup, Telegram permissions, polling, and model inference remain unverified.
In the owner-only private chat, send two messages, restart the worker, and confirm
that a third continues the same session. Exercise `/status` and `/cancel`, then
schedule one result to the private chat and inspect its delivery with `tasks show`.
