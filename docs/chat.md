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

Each invocation sends one message. `chat sessions` lists saved sessions;
`chat show` prints the session, ordered messages, run states, failures, output,
and usage as JSON. Opaque provider continuation is retained privately in SQLite
and omitted from this display. Inspection needs no selected model or login.

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
and a bounded excerpt. Results are ranked by relevance, with a stable message-ID
tie-breaker, and limited to ten matches within `POPPET_TOOL_BYTES`.

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

## Provider and model selection

New sessions use `POPPET_PROVIDER` and the required `POPPET_MODEL`. Existing
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

Tool-capable models receive the three [notes tools](notes.md) and conversation search. Models without tool
support continue to answer text requests. The runner checks complete tool
requests before execution and keeps one provider/model throughout the exchange.
Recorded usage sums all model turns when every turn reports usage, otherwise it
is null. Live account chat remains a manual check and consumes provider usage.

See [worker](worker.md#interactive-commands) for chat while a worker is running.
