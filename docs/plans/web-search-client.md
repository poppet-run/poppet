# Web search client

[Refactoring plans](index.md)

Depends on [Bounded I/O package](bounded-io.md).

## Implementation

Implemented as `@poppet/web-search`. The package owns the search service, Brave
HTTP client, response parsing, source filtering, and result budgeting. It depends
on `@poppet/io` and Effect, without importing the agent or credential storage.

The agent keeps the model-tool definition and argument validation, and converts
search failures into agent errors with the same reason and message. The CLI keeps
credential loading, the opt-in configuration layer, and `web login|status|logout`.

Search and page fetching share URL validation and public-address policy in
`@poppet/io`. The search client uses `readBoundedText` for its 1 MiB response limit.

## Verification

Existing result and HTTP behavior tests move with the package. Argument validation
and conversation tests stay in the agent; configuration and command tests stay in
the CLI. Search errors, result budgets, cancellation, and the 15-second deadline
remain unchanged. No new tests are added for the package extraction.
