# Poppet implementation plan

[Documentation index](README.md)

Phases 1–21 and 24–25 are implemented with automated checks. Live validation
remains outstanding where listed in each phase.
Phases 28–33 are planned only. Plans do not authorize implementation.

Completed phases retain short status summaries, evidence, and outstanding checks.
Use the linked guides for current behavior and setup. Git history retains the
original delivery plans.

The remaining priority order is browser login state, doctor, then calendar
briefing and weekly review trials using existing tools. Independent work such as
doctor need not wait for earlier phases.

Reusable workflows start with [drafting a skill in chat](skills.md#draft-a-skill-from-a-completed-procedure),
owner review, and manual saving into the local skill library. The agent can read
matching skills from an index; it cannot write skills or curate facts automatically.

Updated: 2026-10-23

Storage history: the unreleased base schema was consolidated into version 1.
Phases 23–26 add migrations 2–5 for monitoring, task controls, attachments, and
projects while retaining earlier data. Migrations 6–8 retain archived learning data and active fact history. Historical validation records describe
checks performed at delivery time, not checks rerun for this documentation update.
See [storage](storage.md#schema-and-saved-records),
[development](development.md#store-migrations), and
[architecture](architecture.md) for current contracts and dependency boundaries.

## Phases

- [Phase 1: Foundation and subscription verification](phases/1.md)
- [Phase 2: Provider interface and configured model](phases/2.md)
- [Phase 3: Durable credentials and storage](phases/3.md)
- [Phase 4: Persisted chat](phases/4.md)
- [Phase 5: Tool execution](phases/5.md)
- [Phase 6: Explicit memory](phases/6.md)
- [Phase 7: Durable scheduled tasks](phases/7.md)
- [Phase 8: Unattended operation](phases/8.md)
- [Phase 9: Interactive use with the worker running](phases/9.md)
- [Phase 10: Messaging gateway with Discord thread sessions](phases/10.md)
- [Phase 11: Scheduled results in messaging conversations](phases/11.md)
- [Phase 13: Search past conversations](phases/13.md)
- [Phase 14: Explicit local Markdown skills](phases/14.md)
- [Phase 15: Read a supplied URL](phases/15.md)
- [Phase 16: Session titles and Discord thread names](phases/16.md)
- [Phase 17: Web search](phases/17.md)
- [Phase 18: Task management through chat](phases/18.md)
- [Phase 19: Deeper conversation recall](phases/19.md)
- [Phase 20: MCP server support](phases/20.md)
- [Phase 21: Browser automation with agent-browser](phases/21.md)
- [Phase 24: Editable tasks and snoozing](phases/24.md)
- [Phase 25: Text attachments](phases/25.md)
- [Phase 28: Browser login state across requests](phases/28.md)
- [Phase 29: A useful `poppet doctor`](phases/29.md)
- [Phase 30: Calendar briefings and weekly reviews](phases/30.md)
- [Phase 31: Summaries of trimmed conversation history](phases/31.md)
- [Phase 32: Host commands in an isolated container](phases/32.md)
- [Phase 33: Trusted time for scheduled runs](phases/33.md)

## Validation

Use behavior tests with injected model resolvers and auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
