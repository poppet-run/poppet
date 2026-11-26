# Telegram

[Engineering notes](../README.md)

`@poppet/gateway-telegram` calls the Bot API with `fetch` and long polling, holding each poll for
`timeouts.telegramPollSeconds`, 30 by default. It
has no SDK dependency and needs no public webhook. The
[user guide](https://poppet.run/docs/gateways/telegram/) covers bot setup. See
[gateways](../gateways.md) for the shared contract.

| Module            | Owns                                                       |
| ----------------- | ---------------------------------------------------------- |
| `registration.ts` | The registration entry                                     |
| `settings.ts`     | `channels/telegram.json` and conversation ID parsing       |
| `api.ts`          | Bot API calls and error mapping                            |
| `adapter.ts`      | Polling, conversations, sends, reactions, and topic naming |

## Settings

All settings, including the token, live in `channels/telegram.json` with `0600`
permissions. There is no `config.json` section. The home conversation defaults
to the configured chat. API errors are classified without exposing the token.

## Conversations

The gateway serves one configured chat and one owner.

| Chat                          | Conversation                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| Private chat with the bot     | The whole chat. Every message is addressed to the bot.                |
| Group or non-forum supergroup | The whole chat. A mention or a reply to the bot starts it.            |
| Forum supergroup              | A mention in General opens a new topic. Each topic is a conversation. |

Conversation IDs are the chat ID, or `<chat-id>:<topic-id>` for a forum topic.
The adapter strips `@BotName` mentions and command suffixes such as
`/status@BotName` before the gateway sees the text, so the shared controls work
unchanged. Approvals are text only. Progress shows 👀 while working and 👍 when
finished.

## Topic names

The adapter renames the topics it creates. The Bot API cannot read a topic's
name, so the adapter learns names from topics it created and from topic edit
events. After a restart, renaming stops for topics whose names it has not seen
since. An edit by anyone else stops renaming that topic.

## Limits

- Only one `getUpdates` client may run per token, so one worker per token and no
  webhook.
- Updates queued on Telegram's side, for up to 24 hours, are processed at start.
  The inbox ignores messages it already accepted.
- Only text messages are read. There is no `download`, so a message with files
  gets a reply saying it cannot take them.
- Replies are plain text, so Markdown shows as written.
- Telegram has no idempotency key. A send or topic creation with no clear answer
  is uncertain, and a retry can duplicate it.
