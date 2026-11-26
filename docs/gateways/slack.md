# Slack

[Engineering notes](../README.md)

`@poppet/gateway-slack` connects one Slack workspace over an outbound Socket Mode
connection and the Web API, with `@slack/socket-mode` 3.2.0 and
`@slack/web-api` 8.5.0. No public webhook is needed. The
[user guide](https://poppet.run/docs/gateways/slack/) covers app setup and scopes.
See [gateways](../gateways.md) for the shared contract.

| Module            | Owns                                                          |
| ----------------- | ------------------------------------------------------------- |
| `registration.ts` | The lightweight registration entry                            |
| `settings.ts`     | The `slack` section of `config.json` and the token file       |
| `setup.ts`        | Interactive setup                                             |
| `adapter.ts`      | Socket Mode events, sends, reactions, downloads, and escaping |
| `approvals.ts`    | Block Kit approval buttons                                    |

## Settings

Owner, workspace, and home channel IDs live under `slack` in `config.json`.
`channels/slack.json` holds the bot token and the app token. Direct setup reads
the bot token from the first stdin line and the app token from the second.
Removing the `slack` section turns the gateway off.

## Conversations

One owner and one workspace are allowed. The bot works only in channels it
belongs to. It refuses direct and group messages, archived channels, and shared
channels, including organization-shared channels and channels with pending
external sharing. A mention starts a thread session, and a bound thread takes
follow-ups without a mention. Controls are ordinary messages, not Slack slash
commands, and can carry the bot mention.

Approval prompts carry Block Kit buttons that arrive as Socket Mode interactive
events. `adapter.ts` escapes control characters and markup in approval text. It
implements `download` with authenticated, bounded requests to Slack's file host,
and shows progress with eyes and check-mark reactions. Slack has no typing
indicator, and the adapter has no remote naming, so titles stay local.

## Connection

The adapter marks Socket Mode offline when the socket closes and reconnects after
30 seconds (`timeouts.gatewayRetrySeconds`). A reconnect or a successful event acknowledgement clears a stale
error in `worker status`.

## Destinations

A scheduled destination is a channel ID, or `<channel-id>:<thread-ts>` for a
thread, such as `C123:1700000000.000100`. `--to slack` uses the home channel.
