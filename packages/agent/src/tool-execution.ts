import { Memory } from "@poppet/memory";
import { measureTiming } from "@poppet/provider";
import { Store, StoreError, type Run, type ProjectSnapshot } from "@poppet/store";
import { Effect, Match, Option } from "effect";

import { AgentError } from "#src/errors";
import type { PreparedExternalCall } from "#src/external-tools";
import { executeMemoryCall, type MemoryCall } from "#src/memory-tools";
import { Pages, type FetchPageCall } from "#src/pages";
import type { SessionReadCall, SessionSearchCall } from "#src/search";
import { ChatSettings } from "#src/settings";
import { executeSkillView, type SkillViewCall } from "#src/skill-tools";
import { Skills } from "#src/skills";
import type { PreparedTaskCall } from "#src/task-tools";
import { WebSearch, type WebSearchCall } from "#src/web-search";

type ToolPlan =
  | SessionSearchCall
  | SessionReadCall
  | FetchPageCall
  | MemoryCall
  | SkillViewCall
  | WebSearchCall
  | PreparedTaskCall
  | PreparedExternalCall;

// Failures the model can see and recover from, because no effect is left unconfirmed.
const reportedReasons: ReadonlySet<string> = new Set([
  "tool-arguments",
  "tool-permission",
  "tool-network",
  "tool-authentication",
  "tool-rate-limit",
  "tool-storage",
  "tool-limit",
  "tool-reported",
  "memory-limit",
]);

const reportedStoreReasons: ReadonlySet<string> = new Set([
  "invalid-request",
  "not-found",
  "conflict",
]);

/**
 * Reported failures become the call's reply. Uncertain failures may have changed state, so
 * they end the run without replay. Fatal failures also end the run.
 */
export const toolFailureKind = (
  name: ToolPlan["name"],
  error: AgentError | StoreError,
): "reported" | "uncertain" | "fatal" => {
  if (error instanceof StoreError) {
    if (name !== "manage_tasks") return "fatal";

    if (error.reason === "storage") return "uncertain";

    return reportedStoreReasons.has(error.reason) ? "reported" : "fatal";
  }

  if (name === "external") return error.reason === "tool-reported" ? "reported" : "uncertain";

  if (name === "memory" && error.reason === "memory-storage") return "uncertain";

  return reportedReasons.has(error.reason) ? "reported" : "fatal";
};

/** Preparation runs before any effect, so its failures are reportable unless storage failed. */
export const preflightReported = (error: AgentError | StoreError) =>
  error instanceof StoreError
    ? reportedStoreReasons.has(error.reason)
    : reportedReasons.has(error.reason);

export const failureReason = (error: AgentError | StoreError) =>
  `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`;

export const failureReply = (reason: string, message: string) =>
  JSON.stringify({ error: { reason, message } });

// Results from these tools only add context, so an oversized one can be refused without loss.
const contextOnlyTools: ReadonlySet<string> = new Set([
  "search_sessions",
  "read_session",
  "fetch_page",
  "search_web",
  "view_skill",
]);

export const toolExecution = Effect.gen(function* () {
  const store = yield* Store;
  const memory = yield* Memory;
  const pages = yield* Pages;
  const webSearch = yield* WebSearch;
  const policy = yield* ChatSettings;
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));

  return (
    run: Run,
    callId: string,
    call: ToolPlan,
    project: ProjectSnapshot | null,
    guard: (output: string) => Effect.Effect<void, AgentError>,
  ) => {
    const operation = Effect.gen(function* () {
      yield* store.startToolCall(run.id, callId);
      let urls: ReadonlyArray<string> = [];

      const result: Effect.Effect<string, AgentError | StoreError> = Match.value(call).pipe(
        Match.when({ name: "search_sessions" }, (plan) =>
          store
            .searchSessions(plan.query, policy.toolBytes, project?.name ?? null)
            .pipe(Effect.map((value) => JSON.stringify(value))),
        ),
        Match.when({ name: "read_session" }, (plan) =>
          store
            .readSession(plan.query, policy.toolBytes, project?.name ?? null)
            .pipe(Effect.map((value) => JSON.stringify(value))),
        ),
        Match.when({ name: "fetch_page" }, (plan) => pages.fetch(plan.url)),
        Match.when({ name: "view_skill" }, (plan) =>
          skills === null
            ? Effect.fail(
                new AgentError({ reason: "tool-permission", message: "Skills are unavailable." }),
              )
            : executeSkillView(skills, plan),
        ),
        Match.when({ name: "manage_tasks" }, (plan) => plan.execute),
        Match.when({ name: "external" }, (plan) => plan.execute),
        Match.when({ name: "search_web" }, (plan) =>
          webSearch.search === null
            ? Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message: "Web search is unavailable.",
                }),
              )
            : webSearch.search(plan.query).pipe(
                Effect.mapError(
                  (error) => new AgentError({ reason: error.reason, message: error.message }),
                ),
                Effect.map((value) => {
                  urls = value.results.map((item) => item.url);

                  return JSON.stringify(value);
                }),
              ),
        ),
        Match.when({ name: "memory" }, (plan) =>
          project === null
            ? executeMemoryCall(memory, plan, run.id, policy.factsBytes)
            : executeMemoryCall(memory.forProject(project.name), plan, run.id, 8192),
        ),
        Match.exhaustive,
      );

      const outcome = yield* measureTiming("tool", result).pipe(
        Effect.tap((output) => (contextOnlyTools.has(call.name) ? guard(output) : Effect.void)),
        Effect.map((output) => ({ output, reported: false })),
        Effect.catch((error) => {
          const kind = toolFailureKind(call.name, error);

          if (kind === "reported") {
            const output = failureReply(error.reason, error.message);

            return store
              .finishToolCall(run.id, callId, {
                status: "failed",
                reason: failureReason(error),
                output,
              })
              .pipe(Effect.as({ output, reported: true }));
          }

          return store
            .finishToolCall(run.id, callId, {
              status: kind === "uncertain" ? "uncertain" : "failed",
              reason: failureReason(error),
            })
            .pipe(Effect.andThen(Effect.fail(error)));
        }),
      );

      if (!outcome.reported && call.name !== "manage_tasks")
        yield* store.finishToolCall(run.id, callId, {
          status: "completed",
          output: outcome.output,
        });

      return { output: outcome.output, urls: outcome.reported ? [] : urls };
    });

    // Keep an atomic write and its durable result together on graceful cancellation.
    return call.name === "memory" ? Effect.uninterruptible(operation) : operation;
  };
});
