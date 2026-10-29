# Discord

[Documentation index](../README.md)

## Bot setup

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
Enable its Message Content intent and install it in your server with the bot
scope. In the text channels where you want to use it, give it View Channel, Read Message
History, Send Messages, Create Public Threads, Send Messages in Threads, and Add Reactions permissions. It
does not need Administrator. Use Discord's Developer Mode to copy your user,
server, and home channel IDs. Poppet gets the bot's identity after login.

Choose a private home channel that only trusted people can read. The
configured user is the only person who can invoke Poppet, but everyone with
channel access can read replies containing personal memory and conversation content.

Run `poppet setup` to choose an assistant-capable provider and model, then configure
Discord with token input masked by asterisks. Reruns can reuse the saved token while editing IDs.

For separate gateway setup, save the bot token through stdin as shown below. The
token is never accepted as an argument.

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
    printf '%s\n' "$discord_token" | poppet gateway discord setup <your-user-id> <server-id> <home-channel-id> --key-stdin
)
poppet worker run
```

fish:

```fish
read --silent --prompt-str 'Discord bot token: ' discord_token
printf '%s\n' $discord_token | poppet gateway discord setup <your-user-id> <server-id> <home-channel-id> --key-stdin
set -e discord_token
poppet worker run
```

Replace the angle-bracket placeholders with Discord IDs before running the
setup command. The home channel receives proactive messages and is the default
destination for scheduled results. It does not restrict where you can use the bot. Ordinary
settings are merged into the `discord` section of `config.json`. The token stays in `<POPPET_DATA_DIR>/channels/discord.json`, protected with `0600`
file and `0700` directory permissions. Removing the `discord` section disables
Discord. Model-provider credentials remain separate. Restart an existing worker
after changing channel settings;
on macOS or Linux with systemd, use `worker restart`. The installed worker reads
the saved settings without placing the bot token in its service environment.

## Thread sessions

Mention `@Poppet` with a message in any accessible text channel in the configured
server. The bot starts a thread and replies there. You can also mention it in an
existing thread to attach a session. Once attached, your follow-ups need no mention. Each thread keeps its own history and selected model
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
With `chat.maxConcurrentRequests` above 1, threads and channel mentions run at the
same time, and messages within one thread are answered in order. Cancelling one
thread does not affect requests in another, and an approval reply settles only a
request in its own thread.
These are text messages, not registered Discord slash commands. The bot ignores
other users, bots, and webhooks. DMs, forums, voice, and streaming message edits
are not supported.

## Attachments

Attach images or text files to a mention or a thread message; a message with
files needs no text, and `/new` with files needs no prompt. The supported types
and limits are in [chat](../chat.md#attach-files).

Files download when the request runs, not when the message arrives. Downloads
come only from Discord's CDN over HTTPS, follow no redirects, stop at 5 MiB
whatever size Discord reports, and have a 30-second deadline. A temporary
download failure retries with the request's usual backoff. A refused or rejected
file gets one reply naming it and the reason, and the model is not run. A request
that waits more than a day in the queue can find Discord's file link expired;
send the files again.

## Status and delivery

Use `poppet worker status` for connection state, rejected/dropped event
counts while running, and persisted queue/delivery counts, under `worker.messaging`.
Each registration has an entry in `channels`, including its ID, display name, enabled state, connection
metadata, or configuration error. Persisted queue/delivery totals remain at the
top level and are counted once across channels. When stopped, status inspects
settings without opening messaging connections. Completed answers
are saved before sending; a delivery retry never repeats model or tool work.
Uncertain sends are recorded without automatic resending, since Discord may
already have posted them. Use the session ID and `chat show <session>` to inspect
the saved answer before manually reposting it. No reply is redirected to another
channel when a thread becomes inaccessible. [Scheduled tasks](../tasks.md#deliver-results-to-discord) default to the home
channel with `--channel discord`. Add `--conversation <channel-or-thread-id>` to
select another destination. Use the worker to execute and deliver
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

Parallel conversations passed a live check on 2026-10-27 with `openai-chatgpt`
and the default three slots: a channel mention was answered while another
thread's request ran, two simultaneous requests shared one ChatGPT account,
replies within one thread stayed in order, and cancelling one thread left
another running.

See [worker documentation](../worker.md#foreground-worker) to run messaging with scheduling or install the login worker.

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
authorized conversation. Scheduled results default to the configured home channel.
Request delivery here to save the current thread instead, or local delivery to
keep results on the machine. To deliver to another channel or thread, include its
Discord channel mention or numeric ID in the request. The destination must be in
the configured server and pass the bot's access checks. A plain channel name
requires a mention or ID before the task can be created.
See [task management](../tasks.md#manage-tasks-through-chat) for time,
receipt, and recovery behavior. Scheduled runs cannot manage other tasks.
