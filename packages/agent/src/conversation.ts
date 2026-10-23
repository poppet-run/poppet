import { Memory } from "@poppet/memory";
import { measureTiming, recordTiming } from "@poppet/provider";
import type {
  Completion,
  Message,
  ModelEvent,
  ModelOperations,
  Output,
  ProviderError,
  TextSource,
  Tool,
} from "@poppet/provider";
import { LearnedSkills } from "@poppet/skills";
import {
  Store,
  StoreError,
  type Run,
  type ProjectSnapshot,
  type StoredMessage,
  type DeliveryDestination,
} from "@poppet/store";
import { Cause, Clock, Effect, Exit, Match, Option, Result, Stream } from "effect";

import {
  assembleContext,
  byteSize,
  contextAvailable,
  contextSize,
  outputBudget,
} from "#src/context";
import { AgentError } from "#src/errors";
import { ExternalTools, type PreparedExternalCall } from "#src/external-tools";
import {
  learningMemoryTool,
  memoryTool,
  decodeMemoryCall,
  executeMemoryCall,
  type MemoryCall,
} from "#src/memory-tools";
import { Notes, decodeNoteCall, noteTools, type NoteCall } from "#src/notes";
import {
  Pages,
  decodeFetchPageCall,
  fetchPageTool,
  suppliedPageURLs,
  type FetchPageCall,
} from "#src/pages";
import { maxTextBytes, streamReply } from "#src/reply";
import {
  decodeSessionReadCall,
  decodeSessionSearchCall,
  sessionReadTool,
  sessionSearchTool,
  type SessionReadCall,
  type SessionSearchCall,
} from "#src/search";
import { ChatSettings } from "#src/settings";
import { skillIndex, skillIndexGuidance } from "#src/skill-index";
import {
  decodeSkillManageCall,
  executeSkillManage,
  maxSkillWrites,
  skillLearningGuidance,
  skillManageTool,
  type SkillManageCall,
} from "#src/skill-tools";
import {
  decodeSkillViewCall,
  executeSkillView,
  skillViewTool,
  type SkillViewCall,
} from "#src/skill-tools";
import { Skills } from "#src/skills";
import { ChatTasks, decodeTaskCall, taskTool, type PreparedTaskCall } from "#src/task-tools";
import { WebSearch, decodeWebSearchCall, webSearchTool, type WebSearchCall } from "#src/web-search";

type ConversationEvent = ModelEvent | { readonly type: "reasoning-end" };

type ToolPlan =
  | NoteCall
  | SessionSearchCall
  | SessionReadCall
  | FetchPageCall
  | MemoryCall
  | SkillViewCall
  | SkillManageCall
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

// Note saves commit by renaming; these reasons are raised before that point.
const unsavedNoteReasons: ReadonlySet<string> = new Set([
  "tool-arguments",
  "tool-permission",
  "tool-limit",
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

  if (name === "save_note") return unsavedNoteReasons.has(error.reason) ? "reported" : "uncertain";

  if (name === "memory" && error.reason === "memory-storage") return "uncertain";

  if (name === "manage_skill" && error.reason === "skill-storage") return "uncertain";

  return reportedReasons.has(error.reason) ? "reported" : "fatal";
};

/** Preparation runs before any effect, so its failures are reportable unless storage failed. */
const preflightReported = (error: AgentError | StoreError) =>
  error instanceof StoreError
    ? reportedStoreReasons.has(error.reason)
    : reportedReasons.has(error.reason);

const failureReason = (error: AgentError | StoreError) =>
  `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`;

const failureReply = (reason: string, message: string) =>
  JSON.stringify({ error: { reason, message } });

// Results from these tools carry content the owner did not write.
const untrustedSources: ReadonlySet<string> = new Set(["fetch_page", "search_web", "external"]);

// Results from these tools only add context, so an oversized one can be refused without loss.
const contextOnlyTools: ReadonlySet<string> = new Set([
  "read_note",
  "search_notes",
  "search_sessions",
  "read_session",
  "fetch_page",
  "search_web",
  "view_skill",
]);

/** Builds the bounded model/tool loop; the caller owns the run's final outcome. */
export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const notes = yield* Notes;
  const memory = yield* Memory;
  const pages = yield* Pages;
  const webSearch = yield* WebSearch;
  const policy = yield* ChatSettings;
  const tasks = Option.getOrNull(yield* Effect.serviceOption(ChatTasks));
  const external = Option.getOrNull(yield* Effect.serviceOption(ExternalTools));
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));
  const learned = Option.getOrNull(yield* Effect.serviceOption(LearnedSkills));
  const clock = yield* Clock.Clock;

  const executeTool = (
    run: Run,
    callId: string,
    call: ToolPlan,
    project: ProjectSnapshot | null,
    guard: (output: string) => Effect.Effect<void, AgentError>,
    skillState: { readonly seen: Map<string, number>; writes: number },
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
            : executeSkillView(skills, plan, learned, skillState.seen),
        ),
        Match.when({ name: "manage_skill" }, (plan) =>
          skills === null || learned === null
            ? Effect.fail(
                new AgentError({ reason: "tool-permission", message: "Skills are unavailable." }),
              )
            : ++skillState.writes > maxSkillWrites
              ? Effect.fail(
                  new AgentError({
                    reason: "tool-limit",
                    message: `This run already made ${maxSkillWrites} skill changes. Continue without changing more skills.`,
                  }),
                )
              : executeSkillManage(
                  skills,
                  learned,
                  plan,
                  { runId: run.id, callId },
                  skillState.seen,
                ),
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
        Match.orElse((plan) => notes.execute(plan, project?.notes)),
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
    return call.name === "save_note" || call.name === "memory" || call.name === "manage_skill"
      ? Effect.uninterruptible(operation)
      : operation;
  };

  return (
    run: Run,
    model: ModelOperations,
    text: string,
    history: ReadonlyArray<StoredMessage>,
    runs: ReadonlyArray<Run>,
    prompt: string,
    readOnlyTools: boolean,
    here: Effect.Effect<DeliveryDestination, AgentError> | null = null,
    source?: TextSource,
    project: ProjectSnapshot | null = null,
    selectedSkill: string | null = null,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const attachmentHistory =
          source !== undefined ||
          history.some(
            (entry) => entry.message.role === "user" && entry.message.source !== undefined,
          );

        const catalog =
          model.description.capabilities.tools &&
          external !== null &&
          !(source !== undefined && readOnlyTools)
            ? yield* measureTiming(
                "external-tools",
                external.snapshot(readOnlyTools, { sessionId: run.sessionId, runId: run.id }),
              )
            : [];

        // A frozen per-run index; the model loads a matching skill only when it needs one.
        const skillTools =
          model.description.capabilities.tools && skills !== null && policy.skillIndexBytes > 0;

        // Learning needs the index and view tool, so the model can see revisions to change.
        const learning = skillTools && learned !== null && policy.learnSkills && !readOnlyTools;

        const skillsIndex = skillTools
          ? yield* measureTiming("skill-index", skillIndex(skills, policy.skillIndexBytes, learned))
          : null;

        const skillState = { seen: new Map<string, number>(), writes: 0 };

        const tools = model.description.capabilities.tools
          ? [
              ...noteTools,
              ...catalog.map((entry) => entry.definition),
              sessionSearchTool,
              sessionReadTool,
              fetchPageTool,
              policy.learnMemory ? learningMemoryTool : memoryTool,
              ...(skillsIndex === null && !learning ? [] : [skillViewTool]),
              ...(learning ? [skillManageTool] : []),
              ...(webSearch.search === null ? [] : [webSearchTool]),
              ...(tasks === null || readOnlyTools ? [] : [taskTool]),
            ].filter(
              (tool) => !readOnlyTools || (tool.name !== "save_note" && tool.name !== "memory"),
            )
          : [];

        const identities = new Set<string>();

        for (const tool of tools) {
          const identity = JSON.stringify([tool.namespace, tool.name]);

          if (identities.has(identity))
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "External tool identity collides with another tool.",
              }),
            );
          identities.add(identity);
        }

        const allowedURLs = source?.kind === "voice" ? new Set<string>() : suppliedPageURLs(text);

        // Untrusted content withdraws task, memory, and skill mutations; external tools need explicit opt-in to remain.
        let untrusted = source !== undefined;

        const withdrawn = (tool: Tool) =>
          tool.name === taskTool.name ||
          tool.name === memoryTool.name ||
          tool.name === skillManageTool.name ||
          catalog.some(
            (entry) =>
              entry.availableAfterUntrusted !== true &&
              entry.definition.name === tool.name &&
              entry.definition.namespace === tool.namespace,
          );

        const activeTools = () => (untrusted ? tools.filter((tool) => !withdrawn(tool)) : tools);

        const skillPrompt = [
          ...(skillsIndex === null
            ? []
            : [`${skillIndexGuidance(selectedSkill)}\n${JSON.stringify(skillsIndex)}`]),
          ...(learning ? [skillLearningGuidance] : []),
        ];

        const indexedPrompt =
          skillPrompt.length === 0 ? prompt : `${prompt}\n\n${skillPrompt.join("\n\n")}`;

        const baseInstructions =
          external?.instructions === undefined
            ? indexedPrompt
            : `${indexedPrompt}\n\n${external.instructions}`;

        const instructions =
          (tasks !== null && !readOnlyTools) || source?.kind === "voice"
            ? `${baseInstructions}\nCurrent UTC time: ${new Date(clock.currentTimeMillisUnsafe()).toISOString()}. Resolve relative task times against this time. Ask for an explicit offset or IANA timezone when unclear; task prompts must be self-contained because each occurrence starts a fresh session.`
            : baseInstructions;

        const prepareTool = (call: Extract<Output, { type: "tool-call" }>) =>
          Effect.gen(function* () {
            const requested = tools.find(
              (tool) => tool.name === call.name && tool.namespace === call.namespace,
            );

            if (requested === undefined)
              return yield* Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message: "The requested tool is not allowed in this run.",
                }),
              );

            if (untrusted && withdrawn(requested))
              return yield* Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message:
                    "This tool is disabled after untrusted content entered this run. Propose the action and ask the owner to confirm it in a new message.",
                }),
              );

            const entry = catalog.find(
              (candidate) =>
                candidate.definition.name === call.name &&
                candidate.definition.namespace === call.namespace,
            );

            if (entry !== undefined)
              return { callId: call.callId, plan: yield* entry.prepare(call.arguments) };

            const plan = yield* Match.value(call).pipe(
              Match.when({ name: "search_sessions" }, decodeSessionSearchCall),
              Match.when({ name: "read_session" }, decodeSessionReadCall),
              Match.when({ name: "memory" }, decodeMemoryCall),
              Match.when({ name: "view_skill" }, decodeSkillViewCall),
              Match.when({ name: "manage_skill" }, decodeSkillManageCall),
              Match.when({ name: "search_web" }, decodeWebSearchCall),
              Match.when({ name: "manage_tasks" }, (taskCall) =>
                decodeTaskCall(taskCall).pipe(
                  Effect.flatMap((action) =>
                    tasks!.prepare(action, {
                      origin: readOnlyTools ? "scheduled" : "interactive",
                      runId: run.id,
                      callId: taskCall.callId,
                      here,
                    }),
                  ),
                ),
              ),
              Match.when({ name: "fetch_page" }, (pageCall) =>
                decodeFetchPageCall(pageCall, allowedURLs),
              ),
              Match.orElse(decodeNoteCall),
            );

            return { callId: call.callId, plan };
          });

        const current: Message[] = [
          source === undefined ? { role: "user", text } : { role: "user", text, source },
        ];

        const available = contextAvailable(model.description, policy);
        let turns = 0;
        let callsUsed = 0;
        let outputBytes = 0;
        let reasoningBytes = 0;
        let usage: Completion["usage"] = { inputTokens: 0, outputTokens: 0 };

        const turn = (): Stream.Stream<
          ConversationEvent,
          AgentError | ProviderError | StoreError
        > =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (++turns > policy.modelTurns)
                return yield* Effect.fail(
                  new AgentError({
                    reason: "budget",
                    message: "The run exhausted its model-turn budget.",
                  }),
                );

              const messages = yield* Effect.try({
                try: () =>
                  assembleContext(
                    history,
                    runs,
                    current,
                    model.description,
                    policy,
                    activeTools(),
                    instructions,
                  ),
                catch: (cause) =>
                  cause instanceof AgentError
                    ? cause
                    : new AgentError({
                        reason: "history",
                        message: "Could not assemble conversation history.",
                      }),
              });

              const settings = model.description.capabilities.generationSettings.includes(
                "maxOutputTokens",
              )
                ? { maxOutputTokens: outputBudget(model.description, policy) }
                : {};

              const modelStartedAt = yield* Clock.currentTimeMillis;
              let modelFinished = false;

              return streamReply(
                model,
                {
                  sessionId: run.sessionId,
                  workload: run.workload,
                  instructions,
                  messages,
                  tools: activeTools(),
                  settings:
                    policy.logReasoning && !attachmentHistory
                      ? { ...settings, reasoningSummary: true }
                      : settings,
                },
                run,
              ).pipe(
                Stream.tap((event) => {
                  if (event.type !== "completed") return Effect.void;
                  modelFinished = true;

                  return recordTiming("model-turn", modelStartedAt, { outcome: "completed" });
                }),
                Stream.onExit((exit) =>
                  modelFinished
                    ? Effect.void
                    : recordTiming("model-turn", modelStartedAt, {
                        outcome:
                          Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)
                            ? "interrupted"
                            : "failed",
                      }),
                ),
                Stream.flatMap((event) => {
                  if (event.type === "reasoning-delta") {
                    reasoningBytes += byteSize(event.text);

                    if (reasoningBytes > maxTextBytes)
                      return Stream.fail(
                        new AgentError({
                          reason: "output-limit",
                          message: "The run exceeded the reasoning size limit.",
                        }),
                      );

                    return policy.logReasoning ? Stream.make(event) : Stream.empty;
                  }

                  if (event.type === "text-delta") {
                    outputBytes += byteSize(event.text);

                    return outputBytes > maxTextBytes
                      ? Stream.fail(
                          new AgentError({
                            reason: "output-limit",
                            message: "The run exceeded the output size limit.",
                          }),
                        )
                      : Stream.make(event);
                  }

                  const response = event.response;
                  usage =
                    usage !== null && response.usage !== null
                      ? {
                          inputTokens: usage.inputTokens + response.usage.inputTokens,
                          outputTokens: usage.outputTokens + response.usage.outputTokens,
                        }
                      : null;

                  const calls = response.output.flatMap((part) =>
                    part.type === "tool-call" ? [part] : [],
                  );

                  if (calls.length === 0)
                    return Stream.make({
                      type: "completed" as const,
                      response: { ...response, usage },
                    });

                  const followup = Stream.unwrap(
                    Effect.gen(function* () {
                      yield* store.recordToolCalls(
                        run.id,
                        response,
                        calls.flatMap((call) => {
                          const entry = catalog.find(
                            (candidate) =>
                              candidate.definition.name === call.name &&
                              candidate.definition.namespace === call.namespace,
                          );

                          return entry === undefined
                            ? []
                            : [
                                {
                                  callId: call.callId,
                                  serverId: entry.serverId,
                                  toolName: entry.toolName,
                                },
                              ];
                        }),
                      );

                      if (callsUsed + calls.length > policy.toolCalls)
                        return yield* Effect.fail(
                          new AgentError({
                            reason: "budget",
                            message: "The run exhausted its tool-call budget.",
                          }),
                        );

                      if (turns === policy.modelTurns)
                        return yield* Effect.fail(
                          new AgentError({
                            reason: "budget",
                            message: "The run has no model turn left to use tool results.",
                          }),
                        );

                      // Validate every call before executing any tool in the batch.
                      const planned = yield* Effect.forEach(calls, (call) =>
                        prepareTool(call).pipe(Effect.result),
                      );

                      current.push({
                        role: "assistant",
                        output: response.output,
                        continuation: response.continuation,
                      });

                      const rejected = planned.flatMap((entry) =>
                        Result.isFailure(entry) ? [entry.failure] : [],
                      );

                      if (rejected.length > 0) {
                        const fatal = rejected.find((error) => !preflightReported(error));

                        if (fatal !== undefined) return yield* Effect.fail(fatal);

                        // No call in a rejected batch runs; each one reports why.
                        for (const [index, call] of calls.entries()) {
                          const entry = planned[index]!;

                          const [reason, output] = Result.isFailure(entry)
                            ? [
                                failureReason(entry.failure),
                                failureReply(entry.failure.reason, entry.failure.message),
                              ]
                            : [
                                "agent:not-executed",
                                failureReply(
                                  "not-executed",
                                  "Not run because another call in this batch was invalid. Correct that call, then request this one again.",
                                ),
                              ];

                          yield* store.finishToolCall(run.id, call.callId, {
                            status: "failed",
                            reason,
                            output,
                          });
                          current.push({ role: "tool", callId: call.callId, output });
                          callsUsed++;
                        }

                        return turn();
                      }

                      for (const entry of planned) {
                        if (Result.isFailure(entry)) continue;
                        const { callId, plan } = entry.success;

                        const guard = (output: string) => {
                          const needed = contextSize(
                            [...current, { role: "tool", callId, output }],
                            activeTools(),
                            instructions,
                          );

                          return needed <= available
                            ? Effect.void
                            : Effect.fail(
                                new AgentError({
                                  reason: "tool-limit",
                                  message: `The result is ${needed - available} bytes larger than the space left in this run's context budget. Request less, such as a narrower query or a specific section.`,
                                }),
                              );
                        };

                        const { output, urls } = yield* executeTool(
                          run,
                          callId,
                          plan,
                          project,
                          guard,
                          skillState,
                        );

                        for (const url of urls) allowedURLs.add(url);

                        if (untrustedSources.has(plan.name)) untrusted = true;
                        current.push({ role: "tool", callId, output });
                        callsUsed++;
                      }

                      return turn();
                    }),
                  );

                  return Stream.concat(Stream.make({ type: "reasoning-end" as const }), followup);
                }),
              );
            }),
          );

        return turn();
      }),
    );
});
