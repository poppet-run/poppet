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
import {
  Store,
  StoreError,
  type Run,
  type StoredMessage,
  type DeliveryDestination,
} from "@poppet/store";
import { Cause, Clock, Effect, Exit, Match, Option, Result, Stream } from "effect";

import { Bash, bashTool, prepareBash, type ApproveCommand } from "#src/bash";
import {
  assembleContext,
  byteSize,
  contextAvailable,
  contextSize,
  outputBudget,
} from "#src/context";
import { AgentError } from "#src/errors";
import { ExternalTools } from "#src/external-tools";
import { memoryTool, decodeMemoryCall } from "#src/memory-tools";
import { decodeFetchPageCall, fetchPageTool, suppliedPageURLs } from "#src/pages";
import { maxTextBytes, streamReply } from "#src/reply";
import {
  decodeSessionReadCall,
  decodeSessionSearchCall,
  sessionReadTool,
  sessionSearchTool,
} from "#src/search";
import { ChatSettings } from "#src/settings";
import { skillIndex, skillIndexGuidance } from "#src/skill-index";
import { decodeSkillViewCall, skillViewTool } from "#src/skill-tools";
import { Skills } from "#src/skills";
import { ChatTasks, decodeTaskCall, taskTool } from "#src/task-tools";
import { toolExecution, preflightReported, failureReason, failureReply } from "#src/tool-execution";
import { WebSearch, decodeWebSearchCall, webSearchTool } from "#src/web-search";

type ConversationEvent = ModelEvent | { readonly type: "reasoning-end" };

// Results from these tools carry content the owner did not write.
const untrustedSources: ReadonlySet<string> = new Set([
  "fetch_page",
  "search_web",
  "external",
  "bash",
]);

/** Builds the bounded model/tool loop; the caller owns the run's final outcome. */
export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const webSearch = yield* WebSearch;
  const policy = yield* ChatSettings;
  const tasks = Option.getOrNull(yield* Effect.serviceOption(ChatTasks));
  const external = Option.getOrNull(yield* Effect.serviceOption(ExternalTools));
  const bash = Option.getOrNull(yield* Effect.serviceOption(Bash));
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));
  const clock = yield* Clock.Clock;

  const executeTool = yield* toolExecution;

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
    selectedSkill: string | null = null,
    approveCommand: ApproveCommand | null = null,
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

        const skillsIndex = skillTools
          ? yield* measureTiming("skill-index", skillIndex(skills, policy.skillIndexBytes))
          : null;

        const tools = model.description.capabilities.tools
          ? [
              ...catalog.map((entry) => entry.definition),
              ...(bash === null ||
              source?.kind === "voice" ||
              (source !== undefined && readOnlyTools)
                ? []
                : [bashTool]),
              sessionSearchTool,
              sessionReadTool,
              fetchPageTool,
              memoryTool,
              ...(skillsIndex === null ? [] : [skillViewTool]),
              ...(webSearch.search === null ? [] : [webSearchTool]),
              ...(tasks === null || readOnlyTools ? [] : [taskTool]),
            ].filter((tool) => !readOnlyTools || tool.name !== "memory")
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

        // Untrusted content withdraws task and memory mutations; external tools need explicit opt-in to remain.
        let untrusted = source !== undefined;

        const withdrawn = (tool: Tool) =>
          tool.name === taskTool.name ||
          tool.name === memoryTool.name ||
          catalog.some(
            (entry) =>
              entry.availableAfterUntrusted !== true &&
              entry.definition.name === tool.name &&
              entry.definition.namespace === tool.namespace,
          );

        const activeTools = () => (untrusted ? tools.filter((tool) => !withdrawn(tool)) : tools);

        const skillPrompt =
          skillsIndex === null
            ? []
            : [`${skillIndexGuidance(selectedSkill)}\n${JSON.stringify(skillsIndex)}`];

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
              Match.when({ name: "bash" }, (command) =>
                prepareBash(
                  command,
                  bash!,
                  model,
                  run,
                  text,
                  readOnlyTools,
                  approveCommand,
                  policy.toolBytes,
                ),
              ),
              Match.when({ name: "search_sessions" }, decodeSessionSearchCall),
              Match.when({ name: "read_session" }, decodeSessionReadCall),
              Match.when({ name: "memory" }, decodeMemoryCall),
              Match.when({ name: "view_skill" }, decodeSkillViewCall),
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
              Match.orElse(() =>
                Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message: "The requested tool is not allowed in this run.",
                  }),
                ),
              ),
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

                        const { output, urls } = yield* executeTool(run, callId, plan, guard);

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
