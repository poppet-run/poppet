# Discord

[Engineering notes](../README.md)

`@poppet/gateway-discord` connects one Discord server through an outbound Gateway
connection with discord.js 14.28.1, so no public webhook is needed. discord.js
owns heartbeats, reconnect and resume, and API encoding. It does not retry
ambiguous REST failures. The [user guide](https://poppet.run/docs/gateways/discord/)
covers bot setup. See [gateways](../gateways.md) for the shared contract.

| Module            | Owns                                                            |
| ----------------- | --------------------------------------------------------------- |
| `registration.ts` | The lightweight registration entry                              |
| `settings.ts`     | The `discord` section of `config.json` and the token file       |
| `setup.ts`        | Interactive setup                                               |
| `probe.ts`        | Read-only REST checks that setup uses for the token and IDs     |
| `adapter.ts`      | Events, mentions, threads, sends, reactions, typing, and naming |
| `attachments.ts`  | Attachment listing and downloads                                |
| `approvals.ts`    | Approval buttons                                                |

## Settings

Owner, server, and home channel IDs live under `discord` in `config.json`.
`channels/discord.json` holds only the token, `0600` in a `0700` directory.
Setup merges settings atomically under the ownership locks, and loading never
rewrites either file. Removing the `discord` section turns the gateway off.
Discord reports the bot identity after login, and status stays available while
login retries.

## Threads as sessions

- A real mention of the bot ID in an accessible text channel starts a thread from
  that message. Its text becomes the first input of a new session.
- An owner mention inside an existing thread attaches a session to it. It never
  creates a nested thread or imports earlier messages.
- Later messages in a bound thread continue its session without a mention.
- Mentions match by bot ID, not display name.

The binding key is adapter, bot account, guild, and thread. If Discord stops
allowing access, the local history stays and the failure is reported locally.
The Message Content intent is needed for follow-ups without a mention. See
Discord's [thread permissions](https://docs.discord.com/developers/topics/threads#permissions)
and [message content rules](https://docs.discord.com/developers/events/gateway#message-content-intent).

`@Poppet /status` and `@Poppet /cancel` are text controls, not registered slash
commands. `/status` reports the session, the selected skill, the title, and the
latest saved run.

## Progress

The adapter refreshes the typing indicator every eight seconds while a request
runs and stops on completion, failure, or cancellation. Discord clears it after a
reply or ten seconds after the last refresh. It reacts with 👀 when work starts
and replaces it with ✅ after success. Failure and cancellation remove the 👀.
Reactions and typing are best effort, and their failures never change execution
or delivery, so a crash can leave a stale marker. Replies are split to Discord's
limit with automatic mentions turned off.

## Attachments

`attachments.ts` lists image and text files on a mention or thread message. A
message with files needs no text, and neither does `/new` with files. Downloads
happen when the request runs:

- only from Discord's CDN over HTTPS, with no redirects;
- stopping at the largest attachment limit whatever size Discord reports;
- with a 30-second deadline (`timeouts.attachmentDownloadSeconds`).

A temporary failure retries with the request's backoff. A request that waits
longer than a day can find the file link expired. See
[attachments](../chat.md#attachments) for types and limits.

## Approvals

`approvals.ts` adds **Approve once** and **Deny** buttons after the full
invocation, even when it spans several messages. Clicks are confirmed privately,
and the buttons are replaced with the outcome when the request ends. After a
crash, an old prompt may still show buttons, and clicking one reports that the
request is gone.

## Thread names

The adapter implements `naming`. A new thread starts with a fallback name from
the first message. It is managed only when source-message identity and bot
ownership prove the bot created it, which also lets a lost creation
acknowledgement recover. Attached existing threads keep their names. Before each
rename the adapter checks access and compares the current name with the last name
the bot set. Any recognized external edit stops synchronization, even if the old
name comes back. Names fit Discord's 100 UTF-16 unit limit without splitting a
character. Discord has no compare-and-rename, so an edit between the fetch and
the rename can still race the bot. Permission, rate-limit, and deleted or locked
thread failures leave chat results intact.

## Destinations

A scheduled destination is a channel or thread ID in the configured server, and
`--to discord` uses the home channel. Chat task creation accepts a channel
mention or numeric ID, and needs one of those for a plain channel name. The
adapter checks the bot account, owner, server, parent, and current permissions
before saving and again before sending. Existing Discord destinations keep their
stored format.

## Not supported

DMs, forum channels, voice, and progressive message edits.
