# Slack

[Documentation index](../README.md)

Create a Slack app for your workspace and enable Socket Mode. Generate an
app-level token with `connections:write`, and install the app with bot scopes
`chat:write`, `channels:read`, `channels:history`,
`groups:read`, `groups:history`, `reactions:write`, and `files:read`.
Subscribe to `message.channels` and `message.groups` bot events, and turn on
**Interactivity & Shortcuts** for approval buttons. Socket Mode needs no request URL.
Invite the bot to an unshared channel. Shared channels and DMs are unsupported.

Run `poppet setup` for masked entry of both tokens, or configure directly:

```fish
poppet gateway slack setup --owner-id U123 --team-id T123 --home-channel-id C123 --bot-token <bot-token> --app-token <app-token>
poppet worker run
```

Replace the example IDs and tokens. Direct flags put tokens in shell history;
interactive setup avoids that. Policy is saved under `slack` in `config.json`.
Both tokens are stored in `channels/slack.json` with private file permissions.
Remove the `slack` configuration section to disable the adapter. Restart the
worker after changing settings.

Mention the bot to start a session in a thread. Follow-ups in an attached thread
need no mention. Only the configured owner can invoke it; everyone with channel
access can read replies. `/new`, `/status`, `/cancel`, `/approve`, and `/deny`
use the gateway's existing text controls. These are ordinary messages, not Slack
slash commands. Prefix controls with the bot mention where necessary. Use the
approval controls in the originating thread for [Bash commands](../commands.md)
and [reviewed MCP actions](../mcp.md#review-an-action). Approvals also show
**Approve once** and **Deny** buttons; see
[messaging approval](../commands.md#messaging-approval). If a reviewed MCP action
stops a run, the reply includes the approval or review guidance.

Images and text files use the normal attachment limits. File downloads are
bounded, authenticated, and restricted to Slack's file host. Progress uses eyes
and check-mark reactions. Slack typing indicators and remote thread names are
not implemented. Session titles remain local.

Scheduled delivery uses `--to slack` for the home channel. Use `--to slack:C123`
for an explicit channel or `--to slack:C123:1730000000.000001` for a thread.
Replies are saved before delivery; an uncertain send is not automatically repeated.
During [quiet hours](../configuration.md#quiet-hours) scheduled results and
failure notices wait until the window ends; replies to you are not held.

A failed scheduled occurrence posts a short [failure notice](../tasks.md#failure-notices)
to its configured channel or thread, naming the task and its reason code without
model output or error text. Notices post once per failure streak and skip failures
older than 24 hours. They use the same access checks and delivery queue as successful
results, without changing the thread session. Cancelled, interrupted, and expired
occurrences post nothing.

`poppet worker status` shows Slack connection and event errors. A reconnect or
successful event acknowledgement clears a stale error.

Manual validation requires a real Slack app: check mention and thread replies,
owner rejection, attachments, cancellation, command approval, scheduled results and failure notices,
and worker restart/reconnection. Automated checks do not establish live Slack
permissions or connectivity.
