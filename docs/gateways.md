# Gateways

[Engineering notes](README.md)

A gateway connects a messaging platform to the agent. `@poppet/gateway` owns
authorization, conversation bindings, the durable inbox, approvals, and reply
delivery. Adapter packages own one platform each. Discord, Slack, and Telegram
are bundled. Adapter notes are in [Discord](gateways/discord.md),
[Slack](gateways/slack.md), and [Telegram](gateways/telegram.md). The
[user guide](https://poppet.run/docs/gateways/) covers platform setup.

Gateways run inside the [worker](worker.md#host) and share its store, memory,
model resolver, and agent slots with CLI, web, and scheduled requests. They never
expose the worker socket to the network.

| Module                      | Owns                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `registration.ts`           | `GatewayRegistration`, `GatewayEnvironment`, `GatewayInput` |
| `adapter.ts`                | The `GatewayAdapter` contract and incoming message types    |
| `accept.ts`, `request.ts`   | Authorization, controls, and durable acceptance             |
| `session.ts`                | Session creation and `/new`                                 |
| `execution.ts`              | Inbox dispatch and crash recovery                           |
| `delivery.ts`, `replies.ts` | Chunking and delivery                                       |
| `destination.ts`            | Scheduled destination resolution                            |
| `approvals.ts`              | Pending owner approvals                                     |
| `conversation-naming.ts`    | Thread title synchronization                                |
| `failure.ts`                | Retry decisions for adapter failures                        |
| `settings.ts`               | Protected settings files                                    |
| `repository.ts`             | Bindings, inbox, delivery, and approval records             |

## Registration

`GatewayRegistration` has an ID, a display name, setup usage, a setup operation,
an optional `promptSetup`, and a lazy `load`. `load` returns `null` when the
gateway is unconfigured, or a scoped `GatewayAdapter` layer. Loading settings
must not connect to the platform, and heavy SDK code should load only when the
layer is built. Discord and Slack export lightweight registration entries and
load their SDKs lazily. Telegram calls the Bot API with `fetch`.

`apps/cli/src/commands/gateway/registry.ts` is the only CLI module that imports a
concrete gateway package, and lint enforces it. The CLI generates setup help and
dispatches `gateway <id> setup` through the registration. `promptSetup` has
three parts. `configured` lets `poppet setup` preselect the gateway. `prompt`
collects choices and returns a review summary with a save effect. `remove`
deletes a configured gateway the owner deselects. The host runs the save or
removal after the review. `poppet setup` uses the bundled Discord and Slack
registrations only.

The host supplies `GatewayEnvironment` with the data directory and `GatewayInput`
with bounded, redacted secret input. The adapter owns argument validation,
credential storage, and setup messages. `loadGatewaySettings` and
`saveGatewaySettings` give bounded reads, ownership checks, atomic replacement,
and protected modes, and each adapter owns its schema. Tokens live under
`channels/`, apart from provider credentials and memory, and never appear in
logs, output, launch arguments, or the service environment.

The worker builds a fresh gateway layer per configured registration, so message
streams, authorization, and sessions stay separate. A configuration error stays
with its registration. Duplicate or reserved IDs and malformed registrations
stop gateway startup.

### External adapters

`gatewayPackages` in `config.json` lists entry points of packages installed in
`<POPPET_DATA_DIR>/gateways`. Each entry point default-exports a
`GatewayRegistration`.

- Entries are package names or package subpaths. File paths and URLs are
  rejected.
- Resolution happens from that directory, not the working directory, and must
  stay inside its `node_modules`.
- The directory and entry points must be owned and writable only by the Poppet
  user.
- Nothing is discovered or installed automatically. Changes need a worker
  restart.
- Help lists bundled gateways without importing external code.

External code runs with the worker's privileges, and the loader gives no
dependency isolation. It must use the host's `@poppet/gateway` and Effect
versions. Those workspaces are private, so publishing a standalone adapter still
needs them packaged.

## Adapter contract

The shared types carry the adapter and bot account identity, external message
and conversation IDs, the sender, text, attachments, and the reply destination.
Platform IDs stay opaque strings. An adapter provides:

- `accountId`, which resolves when the platform reports the bot identity, and
  `policy` with the owner and scope IDs;
- a scoped stream of incoming messages;
- `send`, `typing`, and `mark` (`working`, `completed`, or `stopped`);
- `checkAccess` for platform permissions;
- `destination`, which resolves a conversation's parent;
- an optional `homeConversationId` for scheduled results;
- `textLimit` and `naming`;
- `status`;
- optional `download` and `approvals`.

To receive files, the adapter lists them in `IncomingMessage.attachments`, each
with the platform ID, a display name, an optional reported size, and `ref`, the
adapter's own locator. The gateway never reads `ref`. It calls
`download(attachment, maxBytes)` when the request runs, so `ref` must still
resolve then. `download` must stop at `maxBytes` and fail with `unavailable` or
`uncertain` to retry, or any other reason to refuse the file with a reply.
Without `download`, a message with files gets a reply saying the gateway cannot
take them. The agent checks types and limits. A platform that sends file bytes
inline is not supported.

`approvals` adds buttons to [owner approval](commands.md#owner-approval). Text
`/approve` and `/deny` work without it.

## Acceptance

The gateway checks every message and control against the configured owner and
scope before it creates a session or calls the model. Bot and webhook messages
are ignored. `/status`, `/cancel`, `/approve`, and `/deny` are control messages:
they resolve at once, outside the inbox, and only for the current conversation.
`/approve`, `/deny`, and native approval buttons record the owner's decision in
the store and wake the dispatcher without running the model in the control
handler. `/cancel` stops the conversation's queued, waiting, and active requests
that were accepted before it, ends any pending approval, and releases their
slots. `/new` goes through the inbox. See
[skills](skills.md#gateway-sessions).

Accepted messages are deduplicated by adapter, bot account, and external message
ID, and saved before the platform is acknowledged where it supports that. Each
bot account holds at most 64 pending inputs. Platforms without durable
acknowledgement, such as Discord's Gateway, pass events through a bounded memory
queue first, so an event lost before acceptance is gone. Status counts dropped
and rejected events.

A binding maps adapter, bot account, scope, and conversation to a session, and
keeps the initiating message for recovering thread creation. Renaming or
archiving a thread keeps its session. A new binding uses the worker's configured
provider and model. An existing one keeps its session's selection.

Sender authorization does not make replies private. Everyone who can read the
conversation reads the answers, which can include memory. Supporting more users
would need a memory and tool policy, because separate sessions do not isolate the
profile or facts.

## Execution

The gateway reserves a run ID before execution and passes it to `Agent.send`, so a
crash between session creation and binding recovers the same session. The
dispatcher claims an entry from `queued` to `executing` atomically, and only when
no earlier entry in its conversation is queued or executing. It runs up to
`chat.maxConcurrentRequests` requests in a fiber set and reserves no slots of its
own. Each finished request wakes the dispatcher.

When a run parks for owner approval, its inbox entry moves to `waiting` and
holds no slot, and the gateway posts the approval prompt. Once the owner answers,
the entry returns to `queued` and the dispatcher calls `Agent.resume` under the
usual slots, delivering the answer through the entry's chunked delivery. A new
owner message in the same session supersedes a waiting run, interrupts it, and
updates its prompt to say so.

On restart, recovery reads the saved run. An input that never started can run. A
waiting run stays `waiting`, and reconciliation posts any unsent prompt for a
live approval, requeues any decided approval that has not resumed yet, and
updates prompts for settled approvals. An interrupted run follows the store's
no-replay rule and needs a new message. A completed answer is recovered without
another request. Shutdown interrupts active requests and leaves them `executing`
for recovery. A disconnect does not cancel accepted work. An adapter that fails
restarts on its own, and a storage failure stops the worker.

Adapter timeouts come from `io/src/settings.ts`: platform API requests
(`timeouts.gatewayRequestSeconds`, 10), the wait before reconnecting
(`timeouts.gatewayRetrySeconds`, 30), the longest wait between restarts
(`timeouts.gatewayRestartMaxSeconds`, 300), and attachment downloads
(`timeouts.attachmentDownloadSeconds`, 30).

## Delivery

Answers are saved before delivery. A separate loop sends ordered chunks of at most
`textLimit` and records each chunk's state and platform message ID, so a failed
send never reruns inference or tools. Known safe failures retry with bounded
backoff. `failure.ts` lets a temporarily unavailable gateway retry for about a
minute. A send with a lost acknowledgement may have posted, so it is recorded as
uncertain and never resent. Before sending, the gateway rechecks policy and access,
and it never redirects a reply to another conversation.

Scheduled results use the same queue. The host supplies `TaskDestinations`, which
resolves explicit destinations through enabled gateways. The gateway reconciles
finished occurrences into completed inbox entries, without bindings or model
requests:

- A unique `(occurrence_id, run_id)` index makes this idempotent, and queue
  insertion and chunk creation commit together.
- A failed occurrence becomes a fixed notice with the synthetic run ID
  `notice:<occurrence-id>:<finished-at>`, because a failure may have no run and a
  retry reuses the occurrence ID. See
  [failure notices](tasks.md#failure-notices).
- A `NO_REPLY` answer gets an entry with no chunks, so it is reconciled once and
  sends nothing.

Quiet hours are checked when a chunk is about to send, so nothing about the
window is stored. `quietHoursEnd` in `@poppet/config` returns the end of the
window that contains an instant, or null. While it returns a time, scheduled
chunks sort last, so replies keep flowing. When only scheduled chunks remain,
they stay pending without an attempt, the hold is logged once per window, and the
one-second fallback wake sends them afterwards. `TaskDeliveries` reports
`heldUntil` from the same function.

## Thread names

`conversation-naming.ts` synchronizes a generated session title to a thread the
gateway created. The adapter's `naming` capability reports creation ownership,
reads the current name, and renames conditionally. Bindings keep the source
message, the last confirmed name, a pending update, and the last title
considered. Naming starts only after the answer's chunks are confirmed sent. An
external edit turns synchronization off. An uncertain rename is reconciled by
reading the name once, without a second rename. `chat rename` also renames a
managed thread while the gateway runs. A rename has
`timeouts.conversationNamingSeconds`, 10 by default. Adapters without remote
naming keep the title local.

## Status

`worker status` reports gateways under `worker.messaging`. Each registration has
an entry in `channels` with its ID, display name, enabled state, connection
metadata or configuration error, `restarts`, and `lastError`. A later success
clears a stale error. Pending, failed, and uncertain delivery totals are read
once from the repository and appear even when the worker is stopped. Stopped
status reads settings without connecting. Status never includes chat content or
secrets.
