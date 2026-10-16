# Telegram

[Documentation index](index.md)

## Bot setup

Create a bot through [BotFather](https://core.telegram.org/bots/features#creating-a-new-bot).
Keep its token private. The bot ID is the numeric prefix before the token's colon.
Use your numeric Telegram user ID as the owner ID. This adapter accepts ordinary
text only in the private chat between that owner and the bot.

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

The owner has one saved session per bot and private chat. It resumes after worker
restart and retains its selected provider and model. Telegram and Discord have
separate sessions even if external IDs happen to match.

After the first exchange, `/status` reports the session and latest run. `/cancel`
interrupts active work and cancels queued input in this chat without waiting for
inference. The adapter sends typing actions while processing and plain text
replies, split at 4096 UTF-16 units without splitting a Unicode character.
Formatting syntax is sent literally, and link previews are disabled.

Other users, groups, channels, topic messages, edited messages, and non-text
updates do not start model work. They are deliberately ignored. Attachments,
voice, reactions, and Telegram chat renaming are outside this adapter's scope.

## Polling and delivery

The adapter uses the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)
with long polling. Each accepted input commits to the gateway inbox before its
next polling offset is saved. Deliberately ignored updates also advance the
offset. A full inbox leaves the offset before the unaccepted update and retries
later. Offsets are stored separately for every adapter and bot account. A crash
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
`--telegram-chat` and `--discord-thread` cannot be combined.

## Manual validation

Automated tests use injected HTTP replies and temporary SQLite databases. Live
bot setup, Telegram permissions, polling, and model inference remain unverified.
In the owner-only private chat, send two messages, restart the worker, and confirm
that a third continues the same session. Exercise `/status` and `/cancel`, then
schedule one result to the private chat and inspect its delivery with `tasks show`.
