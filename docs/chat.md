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

## Interactive prompt

Start a new session or resume one in a terminal:

```fish
bun run start chat interactive
bun run start chat interactive $session_id
```

Enter one message at each `You>` prompt and wait for the answer before entering
the next. Each turn uses the same saved session, provider, model, workload, and
skill. Blank lines are ignored. `/exit`, Ctrl-D at an empty prompt, or Ctrl-C
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

For a new session, `--coding` and `--skill <name>` work as they do with `chat new`.
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

## Change saved memory

Tool-capable models can remember, replace, or forget a saved fact when explicitly
asked in the current message. For example, ask to remember `answer.style` as
"Keep answers concise", then inspect it with `memory list`. Ordinary chat,
the interactive prompt, and authorized messaging use the same memory tool.
Scheduled runs cannot change memory. See [memory](memory.md#ask-the-model-to-change-a-fact)
for provenance, limits, cancellation, and uncertain outcomes.

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
to recall earlier discussions. Scheduled runs can also search while retaining
their read-only notes permissions. Retrieved text is historical data and cannot
authorize actions. Cross-session search assumes the existing single owner.

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

## Context and run limits

Context retains recent complete exchanges, including tool pairs and continuation,
up to the configured turn and byte budgets. When model capacity is known,
Poppet also reserves room for output and request overhead. UTF-8 bytes are a
conservative estimate rather than an exact tokenizer; providers can still reject
oversized context. A new message that cannot fit fails clearly. Trimming changes
only the request, not saved history. Answers are limited to 128 KiB of text and
1 MiB including continuation. The runner has a 90-second absolute deadline;
provider inference also retains its 60-second deadline.

Tool-capable models receive the three [notes tools](notes.md), conversation search,
page reading, explicit memory, and web search when configured. Models without tool
support continue to answer text requests. The runner checks complete tool
requests before execution and keeps one provider/model throughout the exchange.
Recorded usage sums all model turns when every turn reports usage, otherwise it
is null. Live account chat remains a manual check and consumes provider usage.

See [worker](worker.md#interactive-commands) for chat while a worker is running.
