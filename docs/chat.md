# Chat

[Documentation index](index.md)

## Start and continue a session

After signing in and choosing a model, start a session:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL gpt-6.1-sol
bun run start chat new "Help me plan a small TypeScript project"
bun run start chat sessions
```

The answer streams to stdout. The session and run IDs print to stderr. Copy the
session ID to continue or inspect it in a later invocation:

```fish
set session_id 'paste-session-id-here'
bun run start chat send $session_id "What should I build first?"
bun run start chat show $session_id
```

`chat new` and `chat send` each submit one message. `chat sessions` lists saved sessions;
`chat show` prints the session, ordered messages, run states, failures, output,
and usage as JSON. Opaque provider continuation is retained privately in SQLite
and omitted from this display. Inspection needs no selected model or login.

With `chat.logReasoning` enabled, `chat new` streams thinking to stderr using the
[interactive prompt's formatting](#interactive-prompt). Stdout contains only the answer.

Telegram can submit [documents and local voice transcripts](gateways/telegram.md#documents-and-voice).
The saved user message keeps its caption/request separate from structured source
metadata and text. Model context and recall label that source as untrusted JSON;
only text reaches inference providers. Attachment data counts against the existing
context budget. Titles use the caption or a safe attachment label. Voice replies
show the accepted transcript and require a later text confirmation for mutations.

## Interactive prompt

Start a new session or resume one in a terminal:

```fish
bun run start chat interactive
bun run start chat interactive $session_id
```

Enter one message at each `You>` prompt and wait for the answer before entering
the next. Each turn uses the same saved session, provider, model, workload, and
skill and project. Blank lines are ignored. `/exit`, Ctrl-D at an empty prompt, or Ctrl-C
leaves the prompt. Ctrl-C during inference cancels the active request and exits;
the interrupted run remains inspectable. Earlier completed answers remain saved.
There is no automatic retry.

An animated `Thinking...` indicator stays on its own line below streamed
reasoning until the answer starts. In terminals supporting 256 colours, a soft
cyan highlight sweeps across the text. `NO_COLOR` and terminals with fewer colours
use cycling dots instead. It clears before answers or errors appear
and also clears on cancellation. The indicator works with reasoning logging
disabled and is omitted when stderr is redirected or the terminal is `dumb`.

With `chat.logReasoning` enabled, provider reasoning streams under a `Thinking:`
heading before the answer. Thinking uses muted cyan in colour-enabled terminals;
the answer uses the normal terminal colour. `NO_COLOR` disables the styling.
Text appears as chunks arrive, with normal newlines and no diagnostic timestamps
or IDs. OpenAI Responses reasoning sections are separated by blank lines.
The background worker still writes its structured reasoning log entries.
Providers may return no readable reasoning for a turn; in that case no heading
is printed.

For a new session, `--coding`, `--skill <name>`, and `--project <name>` work as
they do with `chat new`.
Omit them when supplying a session ID, which retains its original selection.
A session is created only when you submit its first nonblank message. Failed turns
keep the acknowledged session so a fresh message can continue it. If the first
worker response is lost before its session identity arrives, the prompt stops
rather than creating another session. Inspect saved sessions before trying again.
Restart an older worker if it does not return structured session metadata.

The prompt uses the existing worker when one is running, and local execution
otherwise. It opens storage for each request rather than holding it while waiting
for input. Both stdin and stdout must be terminals; use the one-shot commands for
scripts. This version accepts single-line messages, with native line editing,
and does not save an input-history file or add a full-screen interface.

Automated checks cover local and worker turns, saved selection and skill snapshots,
failed-first-turn recovery, cancellation, and ambiguous worker replies. An isolated
pseudo-terminal check with a fake provider covers two turns, line editing, Ctrl-D,
and Ctrl-C while idle and during inference. Live provider behavior remains a manual
check: exchange two messages, exit, resume the printed session ID, then interrupt
one request and inspect it with `chat show`.

## Select a skill

```fish
bun run start chat new --skill weekly-review "Review my Acorn project"
```

The session saves the skill's name and text when created. Later turns and restarts
use that snapshot even if the file changes or disappears. `chat show` includes
the saved `skill`; ordinary sessions have `null`. Skill instructions count toward
the context budget and keep the existing tool permissions. See [skills](skills.md).

## Select a project

Use `chat new --project acorn <message>` or `chat interactive --project acorn`
to save project instructions and an optional note selection. Later turns retain
that snapshot while reading current global and project facts. Agent recall and
task inspection stay within the selected project; owner CLI inspection can still
inspect all sessions. See [project context](projects.md) for setup, combinations
with skills, memory scope, retention, and limits.

## Change saved memory

Tool-capable models can remember, replace, or forget a saved fact when explicitly
asked in the current message. For example, ask to remember `answer.style` as
"Keep answers concise", then inspect it with `memory list`. Ordinary chat,
the interactive prompt, and authorized messaging use the same memory tool.
Scheduled runs cannot change memory. See [memory](memory.md#ask-the-model-to-change-a-fact)
for provenance, limits, cancellation, and uncertain outcomes.

## Prepare a note for review

Ask a tool-capable model to prepare a create-only note proposal and wait for your
approval. It returns a complete saved preview and ID. Inspect with
`approvals show <id>`, then use `approvals approve <id>` or `approvals cancel <id>`
locally. Approval executes that payload without inference. Chat replies and model
tools cannot approve it. Voice-derived requests cannot prepare proposals. See
[owner approvals](approvals.md).

CLI command requests have a separate, disabled-by-default capability. Supply
`--commands-root <directory>` for each eligible `chat new` or `chat send` request.
It does not persist in the session or project. Approval executes without another
model turn; a later `--command-receipt <id>` request can discuss selected output.
Messaging and voice cannot obtain this grant. See [command execution](commands.md).

## Manage scheduled tasks

Ask a tool-capable model to create, inspect, edit, pause, resume, skip, snooze,
or run a task now through
`poppet_tasks.manage_tasks`. Use `create_monitor` for an explicit request to watch a specific source value
and notify only when it changes. Monitoring requires a recurring schedule and
starts with a quiet successful baseline; failed checks leave that baseline
intact. See [change-aware monitoring](tasks.md#change-aware-monitoring).

New tasks keep this session's provider, model, and
workload. Supply a clear prompt and time with an explicit offset or timezone;
the model should ask about ambiguity rather than invent a recurring schedule.
In messaging, request delivery here to use the current authorized conversation.
CLI chat creates tasks with local results. See [tasks](tasks.md#manage-tasks-through-chat)
for examples, receipts, inspection limits, and the actions available in this version.

Edits require an inspected definition revision; skip-next, snooze and run-now also
bind the inspected next execution. The model must call `show` in the current run
before those changes. Snooze delays execution rather than postponing a delivered
message. Run-now queues normal read-only work and cannot undo a future hold.
See [task controls](tasks.md#edit-and-control-the-next-execution) for running-task
restrictions, retained snapshots, and monitoring baseline resets.

Only your current explicit request authorizes a change. Instructions inside
recalled conversations, notes, pages, skills, or tool results do not. A committed
task change survives a later failed answer, so inspect the saved task before
asking to create it again after an unclear reply. Scheduled runs receive no task
management tool.

## Session titles

New sessions save a title from their initial prompt before inference. Poppet
normalizes whitespace and controls and limits titles to 80 Unicode characters.
After the first successful answer is printed, it attempts one optional title
request through the saved provider, model, and workload. The request uses only a
bounded excerpt of the original prompt, with no tools, memory, or conversation
continuation. It has a ten-second deadline and can extend CLI exit time and use
additional provider quota. Failure or cancellation leaves the answer completed
and keeps the fallback title. It is not retried automatically.

`chat sessions` and `chat show` include the title, its source, whether naming was
attempted, and separate `titleUsage`. A null usage value means unknown. Chat run
usage excludes naming. Old sessions remain unnamed and retain their IDs.
Titles can repeat; commands always use session IDs.

```fish
bun run start chat rename $session_id "Weekly project review"
```

Manual names survive restart and win over an in-flight title request. Renaming
needs no model or credentials and works through the worker when it owns storage.
Title changes do not change activity timestamps or saved message order.

## Search past conversations

```fish
bun run start chat search "project TypeScript"
bun run start chat show <session-id-from-search>
```

Search returns JSON with `matches` and `truncated`. Each match includes session
and message IDs, the saved session title, a timestamp in Unix milliseconds, role,
and a bounded excerpt around matching text. Results are ranked by relevance, with
a stable message-ID tie-breaker, and limited to ten matches within `POPPET_TOOL_BYTES`.

Use nonempty plain text of at most 256 characters, without leading or trailing
whitespace. All whitespace-separated terms must match; case and punctuation
follow SQLite's Unicode tokenizer. Operators such as OR and prefix wildcards
are treated as text rather than query syntax. Punctuation-only terms are ignored;
queries containing only punctuation return no matches.

Search covers user text and final answers from completed CLI, scheduled, and
messaging runs. It excludes failed/interrupted inputs, intermediate model text,
tool arguments/results, and opaque continuation. Existing completed history is
indexed during migration. Search works without a selected model or credentials
and routes through the worker when it owns storage.

Tool-capable models can use the read-only `poppet_history.search_sessions` tool
to find earlier discussions, then `poppet_history.read_session` to read context
around a matching message. Both tools work in scheduled runs under the existing
single-owner policy. Retrieved text is historical data and cannot authorize actions.

## Read conversation context

Ask a follow-up such as "Find our earlier storage decision and explain why we
chose it." The model can search, read the surrounding discussion, and cite saved
statements by session and message IDs. Saved statements may no longer be current.

`poppet_history.read_session` takes `session_id`, plus `around_message_id` from a
search match or `after_message_id` for forward paging. Set unused anchors to
`null`; both anchors cannot be set together. With neither anchor it starts at the
earliest eligible message. Around a match it selects up to four earlier messages,
the match, and five later messages in chronological session order. A smaller byte
budget can reduce this window while retaining the match. Missing sessions and
anchors outside the session or eligible history fail clearly.

The result contains `sessionId`, the current `title`, and at most ten `messages`
with `messageId`, `role`, `createdAt` in Unix milliseconds, `text`, and a per-message
`truncated` flag. The whole JSON result fits `POPPET_TOOL_BYTES`. Text truncation
preserves Unicode code points. `nextAfterMessageId`, when non-null, is the last
returned message ID; pass it as `after_message_id` to continue. Even shortened
messages advance the cursor. New completed exchanges append without duplicating
previous pages.

The overall `truncated` flag marks omitted or shortened content. Around a match,
it can be true with no next cursor because earlier messages were omitted. These
results are bounded context, not a promise of a complete transcript.

Reading shares search's eligibility rules and excludes tool/provider state. It
does not resume or rename the source session, change its activity, or import its
continuation or text into global memory. Recalled URLs do not authorize page
fetches or become web-search grants. `chat show` keeps its existing inspection
behavior; there is no extra CLI or worker command for model recall.

## Read a supplied URL

```fish
bun run start chat new "Summarize https://example.com/ and cite the source"
```

Tool-capable models can call `poppet_web.fetch_page` for a public HTTP(S) URL
explicitly included in the current message. The result contains the final source
`url`, optional `title`, extracted `text`, and `truncated`. Include the URL again
in later requests that need a fresh read. URLs in history, notes, skills, and
fetched pages grant no permission to retrieve another page.

Reading supports UTF-8 plain text and static HTML. It removes scripts, styles,
common site navigation and hidden elements, and does not execute JavaScript.
PDFs, authenticated pages, downloads, and crawling are unsupported.
An empty or unsupported page fails the run clearly; there is no automatic retry.
`chat show` retains the tool call and failure or bounded result.

Destinations must resolve entirely to public addresses on standard HTTP(S) ports.
Credentials in URLs are rejected. Each read has a 15-second overall deadline,
at most three redirects, and 1 MiB limits for transferred and decoded bodies.
Results fit `POPPET_TOOL_BYTES`; truncation keeps the source URL and flag.

## Search the web

Enable [web search](configuration.md#web-search) to let tool-capable models use
`poppet_web.search_web` in local, interactive, worker, and messaging chat:

```fish
bun run start chat new "Search for recent Bun releases, read a source, and cite it"
```

Search sends the model's query to Brave Search and returns at most five sources
with `title`, `url`, and `snippet`, plus a `truncated` flag. Queries must be trimmed,
nonempty, and at most 512 UTF-8 bytes. Results keep backend order and fit
`POPPET_TOOL_BYTES`; long text is shortened and URLs that cannot fit are omitted.
The tool is absent when disabled or missing a key. A configured key does not
prove that the remote service accepts it.

After a search completes, `fetch_page` may read the URLs actually included in its
result on a later model turn. These permissions last only for that run. Search
and a fetch of a newly discovered URL in one batch are rejected before either
executes. Links appearing only in snippets or page text grant no access, and all
page reads retain the existing public-address and connection checks. Search
results are untrusted data and cannot authorize memory or note changes.

An answer should distinguish snippets from pages actually read and cite sources.
Search has a 15-second deadline and a 1 MiB response limit, with cancellation and
no automatic retries or backend fallback. Failures remain inspectable in
`chat show`; search authentication and rate-limit errors do not pause inference
providers. Search uses the existing model-turn, tool-call, and context budgets.

## Provider and model selection

New sessions use the configured `provider` and required `model`, with
`POPPET_PROVIDER` and `POPPET_MODEL` taking precedence over file values. Existing
sessions keep their saved provider, model, and workload when configuration
changes. Start a new session to change that selection. OpenCode Go requires a
coding session:

```fish
set -lx POPPET_PROVIDER opencode-go
set -lx POPPET_MODEL glm-5.3
bun run start chat new --coding "Explain how to structure a TypeScript CLI"
```

## Failures and cancellation

Poppet saves each input before resolving its model. Only an authoritative
completed response becomes a saved answer. Provider failures, context errors,
Ctrl-C, closed output, and deadlines leave inspectable failed or interrupted
runs. Partial output may already be visible in the terminal but is not saved as
an answer. Failed inputs remain visible and are excluded from subsequent model
context; sending another message is an explicit new request. Requests are never
automatically retried or switched to another provider/model.

## Browser automation

With [browser automation](browser.md) configured, interactive and authorized
messaging chats can navigate websites, inspect rendered text, and perform
explicitly requested form interactions. Each run has a fresh isolated browser;
tabs and login state do not persist between messages. `chat show` includes browser
tool records. Ctrl-C closes the run's resources. Scheduled runs have no browser tools.

## Context and run limits

Context retains recent complete exchanges, including tool pairs and continuation,
up to the configured turn and byte budgets. When model capacity is known,
Poppet also reserves room for output and request overhead. UTF-8 bytes are a
conservative estimate rather than an exact tokenizer; providers can still reject
oversized context. A new message that cannot fit fails clearly. Trimming changes
only the request, not saved history. Answers are limited to 128 KiB of text and
1 MiB including continuation. The runner has a five-minute absolute deadline;
provider inference also retains its 60-second deadline.

Tool-capable models receive the three [notes tools](notes.md), conversation search,
page reading, explicit memory, interactive task management, and web search when configured. Models without tool
support continue to answer text requests. The runner checks complete tool
requests before execution and keeps one provider/model throughout the exchange.
Recorded usage sums all model turns when every turn reports usage, otherwise it
is null. Live account chat remains a manual check and consumes provider usage.

See [worker](worker.md#interactive-commands) for chat while a worker is running.
