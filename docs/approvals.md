# Owner-reviewed actions

This guide describes create-only notes. Opt-in commands share these owner
commands and durable lifecycle; see [command execution](commands.md) for their
separate permissions, process limits, receipts, and recovery.

[Documentation index](index.md)

Ask Poppet to prepare an exact note for review when you want to inspect it before
anything is saved. The `propose_note` tool creates a durable proposal. Only the
owner's local CLI can approve it; approval executes the saved content directly
without another model turn.

## Prepare and review

Use a tool-capable model in chat or authorized messaging:

```fish
bun run start chat new "Prepare a proposal to create reviews/acorn.md with a brief project review. Wait for my approval; do not save the note."
bun run start approvals list
set proposal_id 'paste-the-proposal-id'
bun run start approvals show $proposal_id
bun run start approvals approve $proposal_id
```

`list` shows the 50 most recent proposals with their IDs, paths, digest, state,
expiry and source run. A list entry is a summary. `show` displays the complete
saved content, destination, payload version and SHA-256 digest, source
session/run/call, task provenance when applicable, and durable outcome receipt.
Inspect the full proposal before approving it. Approval returns that same payload
and its result. Inspection and approval need no inference provider or credentials.

To discard a pending proposal:

```fish
bun run start approvals cancel $proposal_id
```

Approval and cancellation use the protected worker socket when a worker is
running, or the ordinary exclusive store owner otherwise. Restart an older worker
to load approval support. A rejected command or lost response cannot cause local
fallback or another execution. If a reply is lost, inspect the same proposal ID.

Conversational "yes", quoted messages, reactions and model tool calls cannot
approve. Messages can request a proposal, but approval and cancellation remain
CLI-only. The model interprets explicit preparation requests under the same
current-user rules as note and memory tools. Files, history and tool results do
not authorize proposals. Voice-derived requests have no proposal tool.

## Create-only behavior

The supported action creates one new UTF-8 `.md`, `.markdown`, or `.txt` note
inside `POPPET_NOTES_DIR`. Paths are relative and reject traversal, links, and
control characters. Content is limited to 64 KiB, with no NUL or malformed Unicode.
The complete proposal preview also has to fit `POPPET_TOOL_BYTES` and the existing
context budget. Oversized previews fail without saving a partial proposal.

Project note selections still restrict the destination. The proposal captures
the current notes root and its filesystem identity, then rechecks policy, path
safety and the target's absence when approved. A changed policy or an existing
file fails the proposal. Publication uses atomic create-if-absent behavior, so a
competing writer's file cannot be replaced. Existing interactive note writes keep
their normal explicit-request behavior. To revise a proposal, cancel it and
prepare a new ID.

## State and recovery

Proposals expire after 24 hours. Their states are `pending`, `executing`,
`completed`, `failed`, `cancelled`, `expired`, or `uncertain`. Expiry is applied
when inspecting or claiming pending work. Waiting for approval holds no agent
permit or database transaction.

Approval atomically claims pending work. Duplicate approval returns its saved
state or receipt and never dispatches it again. Cancellation can win before the
claim; it cannot undo execution already claimed. Once local publication starts,
graceful interruption lets publication and receipt recording finish together.

If a process stops after a claim without a durable outcome, restart marks it
`uncertain`. A published note whose outcome receipt could not be saved also
remains uncertain on recovery. It is never retried automatically. Inspect the
target before preparing another proposal. Proposal IDs are bound to the local
owner and data directory, rather than granting access by themselves.

## Scheduled proposals

Opt in when creating a reporting task and select one exact allowed note path:

```fish
bun run start tasks add acorn-review --cron "0 9 * * 1" --tz Europe/London --proposal-note reviews/acorn.md "Review progress and prepare a create-only note proposal at reviews/acorn.md for owner review."
```

Ordinary tasks have no proposal capability. Monitoring tasks cannot opt in. The
saved capability permits at most one proposal per occurrence at that exact path.
Prompts and skills cannot grant it. Scheduled note, memory, and unreviewed MCP
mutations remain unavailable. Chat-created tasks cannot opt themselves in.

An edit invalidates pending proposals from the old task definition. Clearing
tasks cancels pending proposals while retaining all proposal records and completed
receipts. Changing the path or capability requires a replacement task. This
create-only version cannot propose another note at a path that already exists
after an earlier approval.

Use the existing `--discord-thread`, `--telegram-chat`, or `--whatsapp-chat` flag
for owner notification. Without a messaging destination, inspect proposals
locally. A separate durable notice contains the proposal ID, path, digest, expiry,
and local review command. It is identified as a review notice, not an execution
receipt. Notices retain destination authorization, deduplication and uncertain-send
rules. A delivered notice never approves its proposal.

## External-action gate

External actions remain gated by the owner's choice. Source inspection of the
configured `apple-notes-mcp` 2.15.1 found that `createNote` and
`buildLiveFolderResolution` resolve an account/folder destination by name at
mutation time. They cannot atomically enforce the reviewed folder identity.
No external approval adapter is exposed. A future typed adapter needs its own
identity, precondition, timeout and idempotency checks; displaying arbitrary MCP
arguments is insufficient.

## Validation

Automated checks cover complete previews without note writes, immutable payloads,
owner boundaries, expiry, cancellation and approval races, no-overwrite
publication, receipt rollback and restart uncertainty, lost worker responses,
scheduled permissions, source edits/clearing, and separate notification recovery.

Live model and platform behavior remain manual. Prepare a harmless proposal,
inspect its complete content, approve it, and repeat approval to confirm the same
receipt. Cancel a second proposal and inspect an expired one. For a scheduled
task, check a real notification, review locally, then approve and inspect its note.
