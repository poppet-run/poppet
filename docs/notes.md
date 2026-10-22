# Notes

[Documentation index](index.md)

`read_note`, `search_notes`, and `save_note` operate within `POPPET_NOTES_DIR`.
Use UTF-8 `.md`, `.markdown`, or `.txt` files. Relative paths are preferred;
absolute paths must remain within the canonical notes directory. Root, parent,
and file symlinks are rejected, as are hard-linked files. Searches skip symlinks.

Try the complete flow with an existing notes directory and a tool-capable model:

```fish
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start chat new "Find notes about Acorn, read them, and save a summary as acorn-summary.md."
```

## File operations and limits

Saving creates or atomically replaces a note. Existing content is replaced, so
include the intended path in your request. New files have owner-only permissions;
checked parent directories are created as needed. Each note write is limited to
64 KiB of UTF-8 text. Reads scan at most 64 KiB per note and explicitly report
truncation. Search uses literal case-insensitive text, returning relative paths,
line numbers, and snippets. It scans at most 128 files and 128 directories,
returns at most 100 matches, and rejects directories exceeding 1000 entries.
The per-tool result budget can truncate read/search results further.

## Project note selections

A [project](projects.md#select-notes) can save up to eight relative paths in
`notes.json`. Its runs search, read, and write only those paths, subject to the
normal checks and permissions. The path list stays fixed with the session/task;
contents stay current and are read lazily. Missing notes fail without a fallback.
No selection preserves the configured root policy; `[]` permits no notes.

## Tool execution

Runs default to eight model turns and sixteen tool calls. Every requested batch
is checked against the run's allowed tools and argument schemas before any call
in that batch executes. A batch is not executed unless another model turn remains
to consume its results. Tool results and definitions count toward context size;
the current exchange is kept whole and fails if it cannot fit. The five-minute
run deadline includes all model turns and tools. The 128 KiB text limit applies
across all turns, and each serialized completion is limited to 1 MiB.

## Saved outcomes and recovery

Inputs, complete tool requests, execution states, and results are saved in SQLite.
`chat show` includes a `toolCalls` list. Results are recorded atomically with their
transcript messages. Graceful cancellation waits for an in-flight save and its
result recording before stopping. On reopening, queued calls become interrupted
and started calls without recorded results become uncertain. A write can succeed
before its result is saved; inspect the file before manually retrying an uncertain
write. Failed or interrupted exchanges remain inspectable and are excluded from
later model context. Calls and writes are never automatically replayed.

Local tests cover the full note flow,
boundaries, limits, cancellation, and uncertain outcomes. They use injected models
and do not establish fresh live provider access.
