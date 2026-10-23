# Telegram

[Documentation index](../README.md)

## Bot setup

Create a bot through [BotFather](https://core.telegram.org/bots/features#creating-a-new-bot).
Keep its token private. The bot ID is the numeric prefix before the token's colon.
Use your numeric Telegram user ID as the owner ID. This adapter accepts ordinary
text and single supported attachments only in the private chat between that owner and the bot.

Select an assistant-capable provider and model, then save the token through stdin:

Bash / POSIX sh:

```sh
(
    saved_tty=$(stty -g) || exit 1
    trap 'stty "$saved_tty"' 0
    trap 'exit 1' 1 2 3 15
    printf '%s' 'Telegram bot token: '
    stty -echo || exit 1
    IFS= read -r telegram_token || exit 1
    stty "$saved_tty"
    printf '\n'
    printf '%s\n' "$telegram_token" | poppet gateway telegram setup <bot-id> <owner-id> --key-stdin
)
poppet gateway work
```

fish:

```fish
read --silent --prompt-str 'Telegram bot token: ' telegram_token
printf '%s\n' $telegram_token | poppet gateway telegram setup <bot-id> <owner-id> --key-stdin
set -e telegram_token
poppet gateway work
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
saved [local skill](../skills.md#messaging-sessions). Options precede
the prompt. `/new <message>` starts without a skill. Previous sessions
and history remain; ordinary follow-ups retain the skill snapshot across restart and
local file edits. Selection errors leave the active session unchanged.

After the first exchange, `/status` reports the session, skill, and latest run. `/cancel`
interrupts active work and cancels queued input in this chat without waiting for
inference. The adapter sends typing actions while processing and plain text
replies, split into chunks of at most 4096 UTF-16 units, preferring paragraph, line,
then word breaks, without splitting a Unicode character.
Formatting syntax is sent literally, and link previews are disabled.

Other users, groups, channels, topic messages, and edited messages are deliberately
ignored. Unsupported attachments and forwarded messages from the owner receive a
clear reply; forwarded text was written by someone else, so it cannot act as your
request. Reactions
and Telegram chat renaming remain outside this adapter's scope.

## Text attachments

Send one UTF-8 `.txt`, `.md`, or `.markdown` file. Its caption is your request;
without a caption Poppet gives a short summary. PDFs, voice messages, images,
archives, albums, forwarded attachments and remote file links are unsupported.
Send files directly so a third-party caption cannot act as your current instruction.
Unsupported types are rejected before download or inference.

Downloads are limited to 64 KiB, with at most 32 KiB of accepted text. Oversized
text files are rejected rather than shortened. Combined caption, source,
instructions and tools must still fit the configured chat budget.

Attachment contents and links are untrusted source material. They cannot grant
URL access or authorize memory or task changes. Attachment runs withhold memory
changes, task management, and MCP tools; confirm proposed actions in a subsequent
text message. `/new`, `/status` and `/cancel` are parsed only from your text/caption.
File contents cannot invoke them.

Downloads and UTF-8 decoding run before inference without holding the model
permit. Accepted text is saved before the run starts, so restart or repeated
updates reuse it. Raw bytes are processed in memory without temporary files.
Saved text, source metadata and answers remain in conversation storage and may
enter provider history. Previously accepted PDF text and voice transcripts remain
readable; pending requests with already-extracted text can finish after an update.
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

Run `poppet worker run` to enable scheduling and messaging together, then
select the configured owner's private chat before the prompt:

```sh
poppet tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --telegram-chat <owner-id> "Summarize recent conversations"
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

Send a small Markdown file with and without a caption. Check grounding and clear
rejections for a PDF, a voice recording, and another unsupported file. Cancel during
a download, restart after an accepted file, and confirm no duplicate answer.
Check another sender cannot trigger any download.

Automated tests use injected HTTP replies and temporary SQLite databases. Live
bot setup, Telegram permissions, polling, and model inference remain unverified.
In the owner-only private chat, send two messages, restart the worker, and confirm
that a third continues the same session. Exercise `/status` and `/cancel`, then
schedule one result to the private chat and inspect its delivery with `tasks show`.
