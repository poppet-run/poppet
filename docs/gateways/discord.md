# Discord

[Documentation index](../index.md)

## Bot setup

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
Enable its Message Content intent and install it in your server with the bot
scope. In the intended parent text channel, give it View Channel, Read Message
History, Create Public Threads, Send Messages in Threads, and Add Reactions permissions. It
does not need Administrator. Use Discord's Developer Mode to copy the bot user,
your user, server, and parent channel IDs.

Start with a private parent channel that only trusted people can read. The
configured user is the only person who can invoke Poppet, but everyone with
channel access can read replies containing personal memory and notes.

Select an assistant-capable provider and model, then save the bot token through
stdin. The token is never accepted as an argument. For fish:

```fish
read --silent --prompt-str 'Discord bot token: ' discord_token
printf '%s\n' $discord_token | bun run start gateway discord setup <bot-id> <your-user-id> <server-id> <parent-channel-id> --key-stdin
set -e discord_token
bun run start gateway work
```

Replace the angle-bracket placeholders with Discord IDs before running the
setup command. Additional parent channel IDs can follow the first one. Settings
and the redacted token live in `<POPPET_DATA_DIR>/channels/discord.json`, protected
with `0600` file and `0700` directory permissions. Model-provider credentials
remain separate. Restart an existing worker after changing channel settings;
on macOS, use `worker stop` followed by `worker start`. The installed worker reads
the saved settings without placing the bot token in its LaunchAgent environment.

## Thread sessions

Mention `@Poppet` with a message in an allowed parent text channel. The bot starts
a thread and replies there. Inside any thread under an allowed parent channel,
your text messages are addressed to the bot without a mention. The first message
attaches a session, and subsequent messages continue it. Each thread keeps its own history and selected model
across worker restarts, renames, and archiving. Start a new thread for a new
session. Earlier messages in an existing thread are not imported.

Use `@Poppet /new --skill weekly-review Review Acorn` to start a fresh session
with a saved [local skill](../skills.md#messaging-sessions), in a new thread or an
existing one. `/new <message>` starts without a skill. Previous session history
is retained; ordinary follow-ups keep the active session's skill snapshot.

## Progress and controls

The bot shows Discord's typing indicator while working, including during tool
calls. It refreshes every eight seconds and stops refreshing when the request
finishes, fails, or is cancelled. Discord clears it after a reply or within ten
seconds of the last refresh. Indicator failures do not interrupt the request.

Poppet also reacts to the original message with 👀 when processing starts, then
replaces it with ✅ after a successful run. Failed or cancelled requests clear
the bot's 👀 without adding ✅. These markers are best effort; missing reaction
permissions do not stop chat, and a crash or network error can leave a stale marker.

In an attached thread, `@Poppet /status` reports its session, selected skill, and latest run;
`@Poppet /cancel` interrupts its active request and cancels its queued requests.
These are text messages, not registered Discord slash commands. The bot ignores
other users, bots, and webhooks. DMs, forums, attachments, voice, and streaming
message edits are not supported in this phase.

## Status and delivery

Use `bun run start gateway status` for connection state, rejected/dropped event
counts while running, and persisted queue/delivery counts. Each registration has
an entry in `channels`, including its ID, display name, enabled state, connection
metadata, or configuration error. Persisted queue/delivery totals remain at the
top level and are counted once across channels. When stopped, status inspects
settings without opening messaging connections. Completed answers
are saved before sending; a delivery retry never repeats model or tool work.
Uncertain sends are recorded without automatic resending, since Discord may
already have posted them. Use the session ID and `chat show <session>` to inspect
the saved answer before manually reposting it. No reply is redirected to another
channel when a thread becomes inaccessible. [Scheduled tasks](../tasks.md#deliver-results-to-discord) can select an explicit
thread with `--discord-thread`. Use the combined worker to execute and deliver
them. Scheduled results use the same queue and do not alter thread sessions.
[Telegram private chat](telegram.md) is also supported. WhatsApp remains planned.

## Validation

Automated tests use injected Discord events and API responses. Live bot setup,
permissions, reconnection, and model inference still need manual validation.

See [worker modes](../worker.md#foreground-modes) to run messaging with scheduling or install the combined macOS worker.

## Thread names

New threads use a fallback derived from the initiating message. After the answer
has been delivered, Poppet may generate a concise session title and synchronize
it to the managed thread. `chat rename` also updates a managed thread while the
gateway is running. `/status` includes the local session title.

Poppet manages names only when source-message identity and bot ownership prove
that it created the thread. This also allows recovery after a lost creation
acknowledgement. Attached existing threads keep their names. Before each rename,
the adapter checks current access and compares the remote name with the last
confirmed bot-applied name. A recognized external edit disables synchronization,
even if the user later restores the old name. Discord names also respect its
100 UTF-16-unit limit without splitting a Unicode character.

The saved answer is delivered before optional model naming starts. Naming and
remote updates have separate bounded scopes. Failed permissions, rate limits,
disconnects, or deleted/locked threads leave chat results intact. A lost rename
acknowledgement is checked against the current name, without resending the rename.
Failures can stop synchronization while the local session title stays usable.
Discord has no atomic compare-and-rename operation, so a user edit between the
last fetch and update can still race the bot. Live creation, renaming, and that
race require validation in the private test channel.
