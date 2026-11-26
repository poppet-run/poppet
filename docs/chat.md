# Chat

[Engineering notes](README.md)

A chat run turns one owner message into one saved answer. The agent in
`packages/agent` owns runs, context, budgets, and built-in tools. The terminal
commands live in `apps/cli/src/commands/chat/`. The
[user guide](https://poppet.run/docs/chat/) covers commands and key bindings.

The CLI runs chat in-process when no worker owns the data directory. Otherwise it
sends each message to the worker over the [worker socket](worker.md#socket-transport).
Gateways, web chat, and scheduled tasks call the same `Agent.send`.

## Defaults

`ChatSettingsLive` in `agent/src/settings.ts` builds the `ChatPolicy` from the
`chat` settings and the chat limits in `io/src/settings.ts`. Every budget below
except the facts budget can be changed in `config.json`. See
[configuration](configuration.md#timeouts-and-limits) for ranges.

| Budget                | Default      | Setting                                   |
| --------------------- | ------------ | ----------------------------------------- |
| Context               | 256 KiB      | `limits.contextBytes`                     |
| History               | 20 exchanges | `limits.historyTurns`                     |
| Requested output      | 2048 tokens  | `chat.outputTokens`                       |
| Model turns per run   | 16           | `limits.modelTurns`                       |
| Tool calls per run    | 16           | `limits.toolCalls`                        |
| Tool result           | 16 KiB       | `limits.toolBytes`                        |
| Run deadline          | 300 seconds  | `chat.runDeadlineSeconds`                 |
| Concurrent requests   | 3            | `chat.maxConcurrentRequests`              |
| Personality, profile  | 8 KiB each   | `limits.soulBytes`, `limits.profileBytes` |
| Saved facts           | 8 KiB        | Fixed                                     |
| Skill index           | 8 KiB        | `limits.skillIndexBytes`                  |
| Answer text           | 128 KiB      | `limits.replyTextBytes`                   |
| Serialized completion | 1 MiB        | `limits.completionBytes`                  |
| Inference deadline    | 60 seconds   | `timeouts.inferenceSeconds`               |

## Request slots

`AgentLive` captures `Store`, `ModelResolver`, and `ChatSettings`. Each `send`
stream holds two permits for its whole lifetime, including persistence and
provider cleanup:

- A session permit. Two sends to one session never read the same history or save
  out of order.
- One of the `chat.maxConcurrentRequests` slots, shared by interactive, messaging,
  and scheduled requests.

The stream takes the session permit first, so a request waiting on a busy session
holds no shared slot. The agent drops a session permit once nothing holds or
waits for it. A caller can cancel a waiting request before it creates a run.

## Run lifecycle

`send` saves the input and queues a run before it resolves the model. It then
resolves the session's saved provider and model. The CLI's resolver builds only
that provider's layer inside the stream scope, so credential locks and HTTP
clients stay open for the request and close when it ends.

The session's provider and model never change. A run keeps one model instance
through every tool round trip. Configuration changes affect new sessions only,
because continuation data may not carry across models. The agent never falls back
to another provider or model and never retries a request.

Each run reads a memory snapshot once at start. A fact that a concurrent run saves
appears in the next run.

Run finalizers record a provider, agent, or store failure category, or an
interruption. Only a completed response becomes a saved assistant message, and
the store writes it in the same transaction as the run result. Cancelling,
closing output, or hitting a deadline saves no partial answer, even when text
already reached the terminal. Failed inputs stay visible in `chat show`, and
context excludes them. See [storage](storage.md#runs) for run states.

## Context assembly

`agent/src/context.ts` builds each request from completed runs:

- It trims history at exchange boundaries. A tool request, its results, and the
  provider continuation stay together.
- The newest input must fit alone. Otherwise the run fails with `context-limit`.
- When the model reports its capacity, the context also reserves room for output
  and request overhead. The estimate counts UTF-8 bytes at three bytes per token.
  It is not a tokenizer, so a provider can still reject a request.
- Tool definitions, tool results, memory, and the skill snapshot count toward the
  estimate.
- Trimming changes the request only. Stored history stays whole.

The agent validates imported exchanges that have no run as complete message
sequences.

## Model stream

`agent/src/reply.ts` forwards text deltas as they arrive. It emits a completion
only after the source ends cleanly with one completion that matches the session.
Malformed, missing, duplicate, or trailing events fail the run. Text that arrives
only in the terminal snapshot, or a final suffix that was never streamed, is
emitted before the answer is committed. `reply.ts` also checks continuation, the
finish reason, output limits, and that the completion agrees with the streamed
text.

The run deadline covers provider resolution and streaming. Provider adapters keep
their own 60-second inference deadline.

With `chat.logReasoning` on, readable reasoning streams to the caller. `chat new`
writes it to stderr, and the interactive prompt shows it under a muted `Thinking`
heading. The store saves readable reasoning in the continuation whether or not
logging is on.

## Tool loop

`agent/src/conversation.ts` runs the model and tool loop:

1. It advertises only the tools this run allows. Models without tool support get
   none.
2. It validates the whole batch of tool calls from a completed response. If any
   call is invalid, no call runs and each call reports why.
3. It records the calls, runs them one at a time, and continues with the saved
   results. A side effect always needs another model turn first.

`agent/src/tool-execution.ts` dispatches each call, classifies its outcome, and
writes the tool journal. The store keeps each call in `tool_calls` and moves it
from pending to running to completed or failed. See
[storage](storage.md#tool-call-journal).

A tool failure that left nothing unconfirmed becomes that call's result, so the
model can explain it or try again within the budgets. Invalid arguments, a refused
URL, an unreachable page, and a task change that the task's state forbids all work
this way. A failure with unknown effects ends the run and is saved as uncertain.
A memory write without a saved receipt and an MCP call lost after dispatch both
work this way. Nothing replays an uncertain call. Someone has to inspect the
affected state before asking again.

Recorded usage sums every model turn when every turn reports usage. Otherwise it
is null.

## Untrusted content

Fetched pages, MCP results, recalled conversations, skills, attachments, and Bash
output are data. Only the owner's current message can authorize a change.

Once a run receives a fetched page or an MCP result, or the owner's message has
attachments, the loop withdraws task management, memory changes, and MCP tools
for the rest of the run. Reading tools stay. The model proposes the withdrawn
action instead, and a new owner message can confirm it. Exceptions:

- An MCP server with `availableAfterUntrusted` keeps its allowed tools, except
  reviewed ones.
- Bash output withdraws reviewed MCP tools only.
- A scheduled task keeps its [note tool](tasks.md#task-notes).

## Built-in tools

| Tool                             | Runs                       | Page                                        |
| -------------------------------- | -------------------------- | ------------------------------------------- |
| `poppet_history.search_sessions` | All                        | [Conversation recall](#conversation-recall) |
| `poppet_history.read_session`    | All                        | [Conversation recall](#conversation-recall) |
| `poppet_web.fetch_page`          | All                        | [Page reading](#page-reading)               |
| `poppet_memory.memory`           | Interactive                | [Memory](memory.md#memory-tool)             |
| `poppet_tasks.manage_tasks`      | Interactive                | [Tasks](tasks.md#chat-task-management)      |
| `poppet_tasks.save_note`         | Scheduled                  | [Tasks](tasks.md#task-notes)                |
| `poppet_skills.view_skill`       | When the skill index is on | [Skills](skills.md#skill-index)             |
| `poppet_system.bash`             | All, with review           | [Host commands](commands.md)                |

Scheduled runs never receive memory or task management tools.

## Conversation recall

The store keeps an FTS5 index of completed user messages and final assistant
text. A shared SQL view defines which messages are eligible, and the
run-completion trigger indexes new exchanges in the completion transaction. Tool
content, intermediate model text, failed and interrupted inputs, attachments, and
continuation stay out. Messages are the source of truth. Titles join from
sessions at query time.

`Store.searchSessions` in `store/src/search.ts`:

- accepts trimmed plain text of 1 to 256 characters;
- quotes every term, so operators such as `OR` and `*` are text;
- requires all terms to match, using SQLite's Unicode tokenizer;
- ignores punctuation-only terms, and returns nothing for a query made only of
  them;
- ranks by relevance, then by message ID, and returns at most ten matches.

`store/src/recall.ts` reads a bounded window for `poppet_history.read_session`:

- `around_message_id` returns up to four earlier messages, the match, and five
  later messages, in session order.
- `after_message_id` pages forward. `nextAfterMessageId` is the last returned
  message, so a shortened message still advances the cursor.
- With neither anchor, reading starts at the earliest eligible message. Setting
  both fails.
- A missing session, or an anchor outside the session or its eligible history,
  fails.

Search and recall derive a result count and a per-item byte cap from the 16 KiB
budget. They do not fit the serialized result exactly, so a result can run
slightly over. A smaller budget returns fewer, shorter messages but keeps the
match and at least one earlier message. Truncation keeps whole Unicode code
points, and `truncated` flags cover each message and the whole result.

Recall never changes the source session's history, title, activity, or
continuation, and never grants page URLs or memory writes. The CLI's
`chat search` uses the worker when it owns storage and needs no credentials.

## Page reading

`agent/src/pages.ts` defines `poppet_web.fetch_page` and the `Pages` service. The
CLI composes it with `PageTransportLive` for local, worker, and scheduled runs.

The host collects canonical HTTP and HTTPS URLs from the current owner message,
or from the saved prompt in a scheduled run. Batch validation checks each
requested URL against that set before any tool runs. History, skills, recalled
text, and links inside pages cannot add URLs.

`agent/src/page-network.ts` checks every initial and redirect URL:

- It rejects userinfo and nonstandard ports and strips the fragment.
- It resolves A and AAAA records and rejects the URL if any address is not
  public. The policy in `io/src/public-url.ts` follows the
  [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and
  [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/) special
  registries, and also excludes mapped, translation, and transition ranges.
- It connects to the chosen literal IP, so a second lookup cannot rebind the
  connection. The original hostname supplies Host, SNI, and the certificate check.
- It ignores ambient proxies and sends no cookies, authorization, or provider
  credentials.
- It follows at most three redirects and checks each one again.

One deadline, 15 seconds by default (`timeouts.pageFetchSeconds`), covers DNS, connections, redirects, body reads, and
extraction. Interruption cancels DNS queries and closes HTTP I/O. The transport
stops at `limits.pageBytes`, 1 MiB by default, on the wire before gzip, deflate,
or Brotli decoding, and caps the decoded body at the same size. Incomplete bodies, unsupported compression or MIME types,
HTTP failures, and invalid UTF-8 become a failed tool result. Nothing retries.

`agent/src/page-text.ts` reads UTF-8 plain text and static HTML. Bun's
HTMLRewriter removes scripts, styles, navigation, and hidden elements and adds
text boundaries. A second parse collects the cleaned document, because removal
still emits text callbacks. The pinned `entities` package decodes character
references that the native parser leaves escaped. The result has `url` (the final
source), `title` or null, `text`, and `truncated`. Truncation keeps the URL and
the flag. There is no JavaScript, PDF support, crawling, or page cache.

## Attachments

`agent/src/attachments.ts` identifies and checks files for every entry point:

- Images are PNG, JPEG, WebP, or GIF, identified by their bytes. They need a model
  whose catalog accepts images. ChatGPT reports this through `input_modalities`.
- Text files are UTF-8 without NUL bytes and need an allowed extension, such as
  `.txt`, `.md`, `.log`, `.csv`, `.json`, `.yaml`, or a common source extension.
- By default a message has at most 4 files (`limits.attachmentsPerMessage`).
  Each image is at most 5 MiB (`limits.imageBytes`) and each text file at most
  64 KiB (`limits.textFileBytes`).

One rejected file fails the whole message before inference, with a reply that
names the file. The store saves attachment bytes with the user message. Later
turns resend them while their exchange stays in context. Each image counts as
6 KiB of context and each text file as its size. A request resends at most the 8
newest images and replaces older ones with a note naming the attachment ID. Each
attachment in a request has a unique content ID. The model sees text files
labelled as untrusted content.

Gateways download files when the request runs. See
[gateways](gateways/discord.md#attachments) for the adapter side.

## Session titles

The store owns title metadata and atomic attempt claims. A new session starts with
a fallback title. Accepting its first input replaces it with a prompt title in the
same transaction: whitespace and control characters normalized, at most 80
Unicode characters. Scheduled sessions save the task name instead.

After the host prints or delivers the first answer, `agent/src/title.ts` makes one
optional naming request with the session's provider and model:

- It reads only the first user prompt, cut to 2048 Unicode characters.
- It has no tools, memory, continuation, or transcript writes.
- It bounds the title to 1024 UTF-8 bytes and has a ten-second deadline
  (`timeouts.sessionTitleSeconds`).
- A durable claim comes before model resolution, so a restart never repeats it.
- A separate naming permit allows one naming request at a time, outside the chat
  slots.

A generated title replaces only a fallback title, so a manual rename always wins.
Title usage is saved apart from run usage. Failure keeps the fallback and is not
retried. Title changes never change activity timestamps. Scheduled runs skip
naming. Gateways can rename the platform thread too. See
[Discord thread names](gateways/discord.md#thread-names).

## Interactive prompt

`chat/command.ts` starts the prompt for `poppet chat [session]`. Both stdin and
stdout must be terminals. `TERM=dumb` falls back to a single-line `You>` prompt
without a queue.

- `terminal.ts` owns raw mode, the alternate screen, the enhanced keyboard
  protocol for Shift+Enter, bracketed paste, resize, and restoring the terminal on
  exit or a hung-up PTY.
- `prompt.ts` owns the composer, the per-invocation input history, and the
  message queue. The queue lives in memory and pauses after a failed turn until
  the owner runs `/queue retry` or `/queue resume`.
- `markdown.ts` renders answers and highlights code. Stored text stays Markdown.
  `NO_COLOR` turns off styling.
- `history.ts` loads a resumed session's saved text through the worker when one
  runs, without calling the provider or replaying tools.

The prompt opens storage for each request instead of holding it while waiting for
input. It creates a session only when the first nonblank message is sent. If the
worker's first response is lost before the session ID arrives, the prompt stops
instead of creating a second session. Ctrl-C during inference cancels the request
and exits, leaving an interrupted run.

## Command output

`chat new` and `chat send` stream the answer to stdout and print the session and
run IDs to stderr. The worker returns session metadata with that announcement, so
interactive clients can keep the session after a failed turn. `chat show --json`
returns every saved message, tool call, run output, and usage record, and omits
provider continuation. Listing, showing, searching, renaming, and deleting need
no model or credentials. See [storage](storage.md#session-deletion) for deletion.
