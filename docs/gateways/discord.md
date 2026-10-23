# Discord

[Documentation index](../README.md)

## Bot setup

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
Enable its Message Content intent and install it in your server with the bot
scope. In the intended parent text channel, give it View Channel, Read Message
History, Create Public Threads, Send Messages in Threads, and Add Reactions permissions. It
does not need Administrator. Use Discord's Developer Mode to copy the bot user,
your user, server, and parent channel IDs.

Start with a private parent channel that only trusted people can read. The
configured user is the only person who can invoke Poppet, but everyone with
channel access can read replies containing personal memory and conversation content.

Select an assistant-capable provider and model, then save the bot token through
stdin. The token is never accepted as an argument.

Bash / POSIX sh:

```sh
(
    saved_tty=$(stty -g) || exit 1
    trap 'stty "$saved_tty"' 0
    trap 'exit 1' 1 2 3 15
    printf '%s' 'Discord bot token: '
    stty -echo || exit 1
    IFS= read -r discord_token || exit 1
    stty "$saved_tty"
    printf '\n'
    printf '%s\n' "$discord_token" | poppet gateway discord setup <bot-id> <your-user-id> <server-id> <parent-channel-id> --key-stdin
)
poppet gateway work
```

fish:

```fish
read --silent --prompt-str 'Discord bot token: ' discord_token
printf '%s\n' $discord_token | poppet gateway discord setup <bot-id> <your-user-id> <server-id> <parent-channel-id> --key-stdin
set -e discord_token
poppet gateway work
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
existing one. `/new <message>` starts without a skill.
Previous session history is retained; ordinary follow-ups keep the skill snapshot.
Options precede the prompt; selection errors leave the active session unchanged.

## Progress and controls

The bot shows Discord's typing indicator while working, including during tool
calls. It refreshes every eight seconds and stops refreshing when the request
finishes, fails, or is cancelled. Discord clears it after a reply or within ten
seconds of the last refresh. Indicator failures do not interrupt the request.

Poppet also reacts to the original message with 👀 when processing starts, then
replaces it with ✅ after a successful run. Failed or cancelled requests clear
the bot's 👀 without adding ✅. These markers are best effort; missing reaction
permissions do not stop chat, and a crash or network error can leave a stale marker.

In an attached thread, `@Poppet /status` reports its session, selected skill and project, and latest run;
`@Poppet /cancel` interrupts its active request and cancels its queued requests.
These are text messages, not registered Discord slash commands. The bot ignores
other users, bots, and webhooks. DMs, forums, attachments, voice, and streaming
message edits are not supported in this phase.

## Status and delivery

Use `poppet gateway status` for connection state, rejected/dropped event
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
thread with `--channel discord --conversation <thread-id>`. Use the combined worker to execute and deliver
them. Scheduled results use the same queue and do not alter thread sessions.
Discord is the only bundled adapter. Additional adapters can use the
[external package contract](../development.md#adding-a-channel).

## Command approval

The [Bash tool](../commands.md) can manage the host machine. If command review
requires a person, Poppet posts the exact command, working directory, timeout,
and reason in the original thread. Reply `/approve <id>` or `/deny <id>` using
the ID in that message. Only the configured owner in that same authorized
conversation can answer. Each ID permits one invocation and expires after two
minutes, cancellation, or worker restart. `/cancel` also cancels the pending run.

Approval controls bypass the model queue. Unknown, expired, and reused IDs never
start commands. Cron jobs do not create approval prompts; their occurrence fails,
logs a reason code, and retains the details in `tasks show` without posting.
Successful cron results go to each task's configured destination.

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

## Schedule through chat

With a tool-capable model, ask to create, inspect, pause, or resume a task in this
authorized conversation. Request delivery here to save this conversation as the
result destination after an access check. The model cannot select another chat
or identity. See [task management](../tasks.md#manage-tasks-through-chat) for time,
receipt, and recovery behavior. Scheduled runs cannot manage other tasks.
