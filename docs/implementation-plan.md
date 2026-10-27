# Poppet implementation plan

[Documentation index](README.md)

Phases 28–34 are planned only. Plans do not authorize implementation. Phase
25's text attachments were removed because no messaging adapter supplied
attachments; image and text-file attachments replaced them.

Implemented work has no phase page. Use the linked guides for current behavior,
setup, and validation. Git history retains delivery plans and validation records.

The remaining priority order is browser login state, doctor, then calendar
briefing and weekly review trials using existing tools. Independent work such as
doctor need not wait for earlier phases.

Reusable workflows start with [drafting a skill in chat](skills.md#draft-a-skill-from-a-completed-procedure),
owner review, and manual saving into the local skill library. The agent can read
matching skills from an index; it cannot write skills or curate facts automatically.

Updated: 2026-10-27

Storage history: the unreleased base schema was consolidated into version 1.
Migrations 2–5 add monitoring, task controls, attachments, and projects while
retaining earlier data. Migrations 6–8 retain archived learning data and active
fact history. Store migration 2 allows one active run per session instead of one
across the store.
See [storage](storage.md#schema-and-saved-records),
[development](development.md#store-migrations), and
[architecture](architecture.md) for current contracts and dependency boundaries.

## Phases

- [Phase 25: Text attachments (removed)](phases/25.md)
- [Phase 28: Browser login state across requests](phases/28.md)
- [Phase 29: A useful `poppet doctor`](phases/29.md)
- [Phase 30: Calendar briefings and weekly reviews](phases/30.md)
- [Phase 31: Summaries of trimmed conversation history](phases/31.md)
- [Phase 32: Host commands in an isolated container](phases/32.md)
- [Phase 33: Trusted time for scheduled runs](phases/33.md)
- [Phase 34: Model and reasoning selection for new sessions](phases/34.md)

## Validation

Use behavior tests with injected model resolvers and auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
