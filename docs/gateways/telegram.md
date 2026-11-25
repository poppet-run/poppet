# Telegram

[Documentation index](../README.md)

The Telegram channel talks to the Bot API directly with long polling, so it needs
no SDK and no public webhook.

## Chats and conversations

The channel serves one configured chat and one owner. Only the owner can invoke
Poppet; everyone in the chat can read its replies.

| Chat                           | Conversation                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Your private chat with the bot | The whole chat is one conversation. Every message is addressed to the bot.                     |
| Group or non-forum supergroup  | The whole chat is one conversation. Mention the bot or reply to it to start.                   |
| Forum supergroup               | Mention the bot in General to open a new topic for that request. Each topic is a conversation. |

Conversation IDs are the chat ID, or `<chat-id>:<topic-id>` for a forum topic.
Use them as the home conversation or as a delivery destination.

Mentions such as `@YourBot` and command suffixes such as `/status@YourBot` are
removed before the gateway sees the text, so `/status`, `/cancel`, `/new`,
`/approve`, and `/deny` work as they do in Discord. Poppet reacts with 👀 while
working and 👍 when finished.

Poppet names the topics it creates after the session title. Telegram has no
method for reading a topic's name, so the channel learns names from the topics it
creates and from topic edit events. After a worker restart, renaming stops for
topics whose names have not been seen since. An edit by anyone else also stops
Poppet from renaming that topic.

## Bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Find your numeric user ID, for example from the `from.id` field of
   `https://api.telegram.org/bot<token>/getUpdates` after messaging the bot.
3. For a private chat, the chat ID is your user ID. For a group, add the bot and
   read `chat.id` from `getUpdates`; supergroup IDs start with `-100`.
4. For a forum, make the bot an administrator with Manage Topics. Administrators
   receive every message, so you can continue a topic without mentioning the bot.
   In other groups, either make the bot an administrator or disable privacy mode
   in BotFather.

Do not set a webhook for the bot, and run only one worker per token. Telegram
allows a single `getUpdates` client.

## Setup

Save the settings with named flags:

```fish
read --silent --prompt-str 'Telegram bot token: ' telegram_token
poppet gateway telegram setup --owner-id <id> --chat-id <id> --bot-token "$telegram_token"
set -e telegram_token
poppet worker run
```

Add `--home-conversation-id <chat-id>:<topic-id>` to use a forum topic as home.
The home conversation defaults to the chat itself. All settings, including the
token, are stored in `<POPPET_DATA_DIR>/channels/telegram.json` with `0600`
permissions. Restart the worker after changing them.

## Limits

- Replies are sent as plain text, so Markdown from the model is shown as written.
- Telegram has no idempotency key. If a send or topic creation fails without a
  clear answer, the gateway records it as uncertain, and a retry may duplicate it.
- Updates waiting on Telegram's side (up to 24 hours) are processed when the
  worker starts. The gateway ignores messages it has already accepted.
- Only text messages are read.
