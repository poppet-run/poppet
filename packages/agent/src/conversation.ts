import { measureTiming, recordTiming } from "@poppet/provider";
import type {
  AttachmentContent,
  Completion,
  Message,
  ModelEvent,
  ProviderError,
} from "@poppet/provider";
import { Store, StoreError } from "@poppet/store";
import { Cause, Clock, Effect, Exit, Option, Result, Stream } from "effect";

import type { AgentTool, PreparedCall, RunContext, ToolCall, ToolContext } from "#src/agent-tool";
import { bashTool } from "#src/bash";
import {
  assembleContext,
  byteSize,
  contextAvailable,
  contextSize,
  outputBudget,
} from "#src/context";
import { AgentError } from "#src/errors";
import { ExternalTools, externalAgentTool } from "#src/external-tools";
import { memoryTool } from "#src/memory-tools";
import { fetchPageTool, suppliedPageURLs } from "#src/pages";
import { maxTextBytes, streamReply } from "#src/reply";
import { sessionReadTool, sessionSearchTool } from "#src/search";
import { ChatSettings } from "#src/settings";
import { skillIndex, skillIndexGuidance, type SkillIndex } from "#src/skill-index";
import { skillViewTool } from "#src/skill-tools";
import { Skills } from "#src/skills";
import { taskTool } from "#src/task-tools";
import { toolExecution, preflightReported, failureReason, failureReply } from "#src/tool-execution";
import { webSearchTool } from "#src/web-search";

type ConversationEvent = ModelEvent | { readonly type: "reasoning-end" };

type ConversationStream = Stream.Stream<ConversationEvent, AgentError | ProviderError | StoreError>;

interface PlannedCall {
  readonly callId: string;
  readonly tool: AgentTool;
  readonly prepared: PreparedCall;
}

/** Builds the bounded model/tool loop; the caller owns the run's final outcome. */
export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const policy = yield* ChatSettings;
  const external = Option.getOrNull(yield* Effect.serviceOption(ExternalTools));
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));
  const clock = yield* Clock.Clock;

  const skillView = yield* skillViewTool;
  const task = yield* taskTool;

  // Built-in tools in the order the model sees them; a null tool is absent from this host.
  const builtins: ReadonlyArray<AgentTool | null> = [
    yield* bashTool,
    yield* sessionSearchTool,
    yield* sessionReadTool,
    yield* fetchPageTool,
    yield* memoryTool,
    skillView,
    yield* webSearchTool,
    task,
  ];

  const executeTool = yield* toolExecution;

  /** Offers this run's external tools, then the built-ins it may use, each identity at most once. */
  const chooseTools = ({ run, model, origin }: RunContext) =>
    Effect.gen(function* () {
      const catalog =
        model.description.capabilities.tools && external !== null
          ? yield* measureTiming(
              "external-tools",
              external.snapshot(origin === "scheduled", {
                sessionId: run.sessionId,
                runId: run.id,
              }),
            )
          : [];

      // A frozen per-run index; the model loads a matching skill only when it needs one.
      const skillTools =
        model.description.capabilities.tools && skills !== null && policy.skillIndexBytes > 0;

      const skillsIndex = skillTools
        ? yield* measureTiming("skill-index", skillIndex(skills, policy.skillIndexBytes))
        : null;

      const tools: ReadonlyArray<AgentTool> = model.description.capabilities.tools
        ? [
            ...catalog.map(externalAgentTool),
            ...builtins.filter(
              (tool): tool is AgentTool =>
                tool !== null &&
                (tool !== skillView || skillsIndex !== null) &&
                (origin === "interactive" || tool.availableWhenScheduled),
            ),
          ]
        : [];

      const identities = new Set<string>();

      for (const tool of tools) {
        const identity = JSON.stringify([tool.definition.namespace, tool.definition.name]);

        if (identities.has(identity))
          return yield* Effect.fail(
            new AgentError({
              reason: "tool-permission",
              message: "External tool identity collides with another tool.",
            }),
          );
        identities.add(identity);
      }

      return { tools, skillsIndex };
    });

  /** Extends the run's prompt with the skill index, host tool policy, and the time tasks resolve against. */
  const buildInstructions = (
    { prompt, origin, selectedSkill }: RunContext,
    skillsIndex: SkillIndex | null,
  ) => {
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

    return task !== null && origin === "interactive"
      ? `${baseInstructions}\nCurrent UTC time: ${new Date(clock.currentTimeMillisUnsafe()).toISOString()}. Resolve relative task times against this time. Ask for an explicit offset or IANA timezone when unclear; task prompts must be self-contained because each occurrence starts a fresh session.`
      : baseInstructions;
  };

  return (runContext: RunContext) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { run, model, text, attachments, history, runs } = runContext;
        const { tools, skillsIndex } = yield* chooseTools(runContext);
        const instructions = buildInstructions(runContext, skillsIndex);
        const allowedURLs = suppliedPageURLs(text);
        const context: ToolContext = { ...runContext, pageURLs: allowedURLs };

        // Untrusted content withdraws task and memory mutations; external tools need explicit opt-in to remain.
        let untrusted = attachments.length > 0;

        const activeTools = () =>
          (untrusted ? tools.filter((tool) => !tool.withdrawnWhenUntrusted) : tools).map(
            (tool) => tool.definition,
          );

        const findTool = (call: ToolCall) =>
          tools.find(
            (tool) =>
              tool.definition.name === call.name && tool.definition.namespace === call.namespace,
          );

        const prepareTool = (call: ToolCall) =>
          Effect.gen(function* () {
            const tool = findTool(call);

            if (tool === undefined)
              return yield* Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message: "The requested tool is not allowed in this run.",
                }),
              );

            if (untrusted && tool.withdrawnWhenUntrusted)
              return yield* Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message:
                    "This tool is disabled after untrusted content entered this run. Propose the action and ask the owner to confirm it in a new message.",
                }),
              );

            return {
              callId: call.callId,
              tool,
              prepared: yield* tool.prepare(call, context),
            } satisfies PlannedCall;
          });

        const current: Message[] = [
          attachments.length === 0 ? { role: "user", text } : { role: "user", text, attachments },
        ];

        // Saved attachment contents, read once per run as the assembled context first needs them.
        const contents = new Map<string, AttachmentContent>();

        const attachmentContents = (messages: ReadonlyArray<Message>) =>
          Effect.gen(function* () {
            const references = messages.flatMap((message) =>
              message.role === "user" ? (message.attachments ?? []) : [],
            );

            const missing = references.filter((reference) => !contents.has(reference.id));

            for (const saved of yield* store.attachments(
              run.sessionId,
              missing.map((reference) => reference.id),
            ))
              contents.set(
                saved.id,
                saved.mediaType === "text/plain"
                  ? { id: saved.id, text: new TextDecoder().decode(saved.body) }
                  : { id: saved.id, base64: Buffer.from(saved.body).toString("base64") },
              );

            if (references.some((reference) => !contents.has(reference.id)))
              return yield* Effect.fail(
                new AgentError({
                  reason: "history",
                  message: "A saved attachment is missing. Start a new session.",
                }),
              );

            return references.map((reference) => contents.get(reference.id)!);
          });

        const available = contextAvailable(model.description, policy);
        let turns = 0;
        let callsUsed = 0;
        let outputBytes = 0;
        let reasoningBytes = 0;
        let usage: Completion["usage"] = { inputTokens: 0, outputTokens: 0 };

        /** Requests one model turn within the run's turn budget and times it. */
        const turn = (): ConversationStream =>
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

              const sent = yield* attachmentContents(messages);

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
                  attachments: sent,
                  settings: policy.logReasoning
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
                Stream.flatMap(handleEvent),
              );
            }),
          );

        /** Bounds streamed text and reasoning; a completed response either ends the run or calls tools. */
        const handleEvent = (event: ModelEvent): ConversationStream => {
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

          return Stream.concat(
            Stream.make({ type: "reasoning-end" as const }),
            toolBatch(response, calls),
          );
        };

        /** Journals a batch of calls, then runs it only if every call prepared, then takes the next turn. */
        const toolBatch = (response: Completion, calls: ReadonlyArray<ToolCall>) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* store.recordToolCalls(
                run.id,
                response,
                calls.flatMap((call) => {
                  const identity = findTool(call)?.external;

                  return identity === undefined ? [] : [{ callId: call.callId, ...identity }];
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
                yield* rejectBatch(calls, planned);
              } else
                yield* executeBatch(
                  planned.flatMap((entry) => (Result.isSuccess(entry) ? [entry.success] : [])),
                );

              return turn();
            }),
          );

        /** No call in a rejected batch runs; each one reports why. */
        const rejectBatch = (
          calls: ReadonlyArray<ToolCall>,
          planned: ReadonlyArray<Result.Result<PlannedCall, AgentError | StoreError>>,
        ) =>
          Effect.gen(function* () {
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
          });

        /** Runs prepared calls in order; context-only results must still fit the run's budget. */
        const executeBatch = (planned: ReadonlyArray<PlannedCall>) =>
          Effect.gen(function* () {
            for (const { callId, tool, prepared } of planned) {
              const guard = (output: string) => {
                const needed = contextSize(
                  [...current, { role: "tool", callId, output }],
                  activeTools(),
                  instructions,
                  policy.imageContextBytes,
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

              const { output, urls } = yield* executeTool(run, callId, tool, prepared, guard);

              for (const url of urls) allowedURLs.add(url);

              if (tool.untrustedResult) untrusted = true;
              current.push({ role: "tool", callId, output });
              callsUsed++;
            }
          });

        return turn();
      }),
    );
});
