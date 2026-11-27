import { limit, timeoutSeconds } from "@poppet/io";
import { measureTiming, recordTiming } from "@poppet/provider";
import type {
  AttachmentContent,
  Completion,
  Message,
  ModelEvent,
  ProviderError,
} from "@poppet/provider";
import type { Approval, StoreError } from "@poppet/store";
import { Store, callDigest } from "@poppet/store";
import { Cause, Clock, Effect, Exit, Option, Result, Stream } from "effect";

import { ownerDenied } from "#src/approvals/action-approval";
import type { ParkRequest } from "#src/approvals/action-approval";
import {
  assembleContext,
  byteSize,
  contextAvailable,
  contextSize,
  outputBudget,
} from "#src/context";
import { AgentError } from "#src/errors";
import { noReply } from "#src/no-reply";
import { fetchPageTool, suppliedPageURLs } from "#src/pages/pages";
import { streamReply } from "#src/reply";
import { ChatSettings } from "#src/settings";
import { skillIndex, skillIndexGuidance } from "#src/skills/skill-index";
import type { SkillIndex } from "#src/skills/skill-index";
import { withMentionedSkills } from "#src/skills/skill-mentions";
import { skillViewTool } from "#src/skills/skill-tools";
import { Skills } from "#src/skills/skills";
import type {
  AgentTool,
  PreparedCall,
  ReviewableCall,
  RunContext,
  ToolCall,
  ToolContext,
} from "#src/tools/agent-tool";
import { bashTool } from "#src/tools/bash";
import { ExternalTools, externalAgentTool } from "#src/tools/external-tools";
import { memoryTool } from "#src/tools/memory-tools";
import { sessionReadTool, sessionSearchTool } from "#src/tools/search";
import { taskNoteGuidance, taskNoteTool } from "#src/tools/task-note";
import { taskTool } from "#src/tools/task-tools";
import {
  toolExecution,
  preflightReported,
  failureReason,
  failureReply,
} from "#src/tools/tool-execution";

type ConversationEvent =
  | ModelEvent
  | { readonly type: "reasoning-end" }
  | { readonly type: "waiting"; readonly approval: Approval };

type ConversationStream = Stream.Stream<ConversationEvent, AgentError | ProviderError | StoreError>;

const waiting = (approval: Approval): ConversationStream =>
  Stream.make({ type: "waiting" as const, approval });

interface PlannedCall {
  readonly callId: string;
  readonly tool: AgentTool;
  readonly prepared: PreparedCall | ReviewableCall;
}

const scheduledRunGuidance = [
  "## Scheduled run",
  [
    "This is a scheduled run.",
    "If the task prompt makes reporting conditional and the condition is not met,",
    `reply with exactly ${noReply} and nothing else.`,
    "Otherwise answer normally.",
  ].join(" "),
].join("\n");

const localTime = (now: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }).format(now);

const taskSchedulingGuidance = (now: number, timeZone: string | null) =>
  [
    "## Task scheduling",
    [
      `Current UTC time: ${new Date(now).toISOString()}.`,
      ...(timeZone === null
        ? [
            "Resolve relative task times against this time.",
            "Ask for an explicit offset or IANA timezone when unclear;",
          ]
        : [
            `The owner's timezone is ${timeZone}, where it is ${localTime(now, timeZone)}.`,
            "Resolve relative task times against this time.",
            `Use ${timeZone} when the owner gives no offset or timezone;`,
          ]),
      "task prompts must be self-contained because each occurrence starts a fresh session.",
    ].join(" "),
  ].join("\n");

const reviewedMCP = (tool: AgentTool) => tool.external !== undefined && tool.reviewed === true;

const withdrawnError = (tool: AgentTool) =>
  new AgentError({
    reason: reviewedMCP(tool) ? "mcp-denied" : "tool-permission",
    message: reviewedMCP(tool)
      ? "Reviewed MCP tools are disabled after untrusted content enters this run. Ask for the action and target in a fresh owner message."
      : "This tool is disabled after untrusted content entered this run. Propose the action and ask the owner to confirm it in a new message.",
  });

export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const policy = yield* ChatSettings;
  const replyTextBytes = yield* limit("replyTextBytes");
  const external = Option.getOrNull(yield* Effect.serviceOption(ExternalTools));
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));
  const clock = yield* Clock.Clock;

  const skillView = yield* skillViewTool;
  const task = yield* taskTool;

  const builtins: ReadonlyArray<AgentTool | null> = [
    yield* bashTool,
    yield* sessionSearchTool,
    yield* sessionReadTool,
    yield* fetchPageTool,
    yield* memoryTool,
    skillView,
    task,
  ];

  const executeTool = yield* toolExecution;

  const chooseTools = ({ run, model, origin, taskNote }: RunContext) =>
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

      const skillTools =
        model.description.capabilities.tools && skills !== null && policy.skillIndexBytes > 0;

      const skillsIndex = skillTools
        ? yield* measureTiming("skill-index", skillIndex(skills, policy))
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
            ...(origin === "scheduled" && taskNote !== null ? [taskNoteTool] : []),
          ]
        : [];

      const identities = new Set<string>();

      for (const tool of tools) {
        const identity = JSON.stringify([tool.definition.namespace, tool.definition.name]);

        if (identities.has(identity)) {
          return yield* Effect.fail(
            new AgentError({
              reason: "tool-permission",
              message: "External tool identity collides with another tool.",
            }),
          );
        }

        identities.add(identity);
      }

      return { tools, skillsIndex };
    });

  const buildInstructions = (
    { prompt, origin, selectedSkill, taskNote }: RunContext,
    skillsIndex: SkillIndex | null,
  ) => {
    const indexedPrompt =
      skillsIndex === null
        ? prompt
        : `${prompt}\n\n${skillIndexGuidance(selectedSkill)}\n${JSON.stringify(skillsIndex)}`;

    const baseInstructions =
      external?.instructions === undefined
        ? indexedPrompt
        : `${indexedPrompt}\n\n${external.instructions}`;

    const scheduledInstructions =
      taskNote === null
        ? baseInstructions
        : `${baseInstructions}\n\n${taskNoteGuidance(taskNote.text)}`;

    if (origin === "scheduled") {
      return `${scheduledInstructions}\n\n${scheduledRunGuidance}`;
    }

    return task !== null
      ? `${baseInstructions}\n\n${taskSchedulingGuidance(clock.currentTimeMillisUnsafe(), policy.timeZone)}`
      : baseInstructions;
  };

  return (runContext: RunContext) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { run, model, text, attachments, runs, mentionedSkills } = runContext;

        const history = runContext.history.map((entry) => ({
          ...entry,
          message: withMentionedSkills(entry.message),
        }));

        const { tools, skillsIndex } = yield* chooseTools(runContext);
        const instructions = buildInstructions(runContext, skillsIndex);
        const allowedURLs = suppliedPageURLs(text);
        let untrusted = attachments.length > 0;

        const context: ToolContext = {
          ...runContext,
          pageURLs: allowedURLs,
          hasUntrustedContent: () => untrusted,
        };

        const activeTools = () =>
          (untrusted ? tools.filter((tool) => !tool.withdrawnWhenUntrusted) : tools).map(
            (tool) => tool.definition,
          );

        const findTool = (call: Pick<ToolCall, "name" | "namespace">) =>
          tools.find(
            (tool) =>
              tool.definition.name === call.name && tool.definition.namespace === call.namespace,
          );

        const prepareTool = (call: ToolCall) =>
          Effect.gen(function* () {
            const tool = findTool(call);

            if (tool === undefined) {
              return yield* Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message: "The requested tool is not allowed in this run.",
                }),
              );
            }

            if (untrusted && tool.withdrawnWhenUntrusted) {
              return yield* Effect.fail(withdrawnError(tool));
            }

            return {
              callId: call.callId,
              tool,
              prepared: yield* tool.prepare(call, context),
            } satisfies PlannedCall;
          });

        const current: Array<Message> = [
          withMentionedSkills({
            role: "user",
            text,
            ...(attachments.length > 0 && { attachments }),
            ...(mentionedSkills.length > 0 && { skills: mentionedSkills }),
          }),
        ];

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
            )) {
              contents.set(
                saved.id,
                saved.mediaType === "text/plain"
                  ? { id: saved.id, text: new TextDecoder().decode(saved.body) }
                  : { id: saved.id, base64: Buffer.from(saved.body).toString("base64") },
              );
            }

            const loaded = references.flatMap((reference) => {
              const item = contents.get(reference.id);

              return item === undefined ? [] : [item];
            });

            if (loaded.length !== references.length) {
              return yield* Effect.fail(
                new AgentError({
                  reason: "history",
                  message: "A saved attachment is missing. Start a new session.",
                }),
              );
            }

            return loaded;
          });

        const available = contextAvailable(model.description, policy);
        let turns = 0;
        let callsUsed = 0;
        let outputBytes = 0;
        let reasoningBytes = 0;
        let usage: Completion["usage"] = { inputTokens: 0, outputTokens: 0 };

        const turn = (): ConversationStream =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (++turns > policy.modelTurns) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "budget",
                    message: "The run exhausted its model-turn budget.",
                  }),
                );
              }

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
                  instructions,
                  messages,
                  tools: activeTools(),
                  attachments: sent,
                  settings: { ...settings, reasoningSummary: true },
                },
                run,
              ).pipe(
                Stream.tap((event) => {
                  if (event.type !== "completed") {
                    return Effect.void;
                  }

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

        const handleEvent = (event: ModelEvent): ConversationStream => {
          if (event.type === "reasoning-delta") {
            if (!policy.logReasoning) {
              return Stream.empty;
            }

            reasoningBytes += byteSize(event.text);

            if (reasoningBytes > replyTextBytes) {
              return Stream.fail(
                new AgentError({
                  reason: "output-limit",
                  message: "The run exceeded the reasoning size limit.",
                }),
              );
            }

            return Stream.make(event);
          }

          if (event.type === "text-delta") {
            outputBytes += byteSize(event.text);

            return outputBytes > replyTextBytes
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

          if (calls.length === 0) {
            return Stream.make({
              type: "completed" as const,
              response: { ...response, usage },
            });
          }

          return Stream.concat(
            Stream.make({ type: "reasoning-end" as const }),
            toolBatch(response, calls),
          );
        };

        const toolBatch = (response: Completion, calls: ReadonlyArray<ToolCall>) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* store.recordToolCalls(
                run.id,
                response,
                calls.flatMap((call) => {
                  const tool = findTool(call);

                  return tool?.external === undefined && tool?.reviewed !== true
                    ? []
                    : [{ callId: call.callId, ...tool.external, reviewed: tool.reviewed === true }];
                }),
              );

              if (callsUsed + calls.length > policy.toolCalls) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "budget",
                    message: "The run exhausted its tool-call budget.",
                  }),
                );
              }

              if (turns === policy.modelTurns) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "budget",
                    message: "The run has no model turn left to use tool results.",
                  }),
                );
              }

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

                if (fatal !== undefined) {
                  return yield* Effect.fail(fatal);
                }

                yield* rejectBatch(calls, planned);
              } else {
                const parked = yield* executeBatch(
                  planned.flatMap((entry) => (Result.isSuccess(entry) ? [entry.success] : [])),
                );

                if (parked !== null) {
                  return waiting(parked);
                }
              }

              return turn();
            }),
          );

        const rejectBatch = (
          calls: ReadonlyArray<ToolCall>,
          planned: ReadonlyArray<Result.Result<PlannedCall, AgentError | StoreError>>,
        ) =>
          Effect.gen(function* () {
            for (const [index, call] of calls.entries()) {
              const entry = planned[index];

              if (entry === undefined) {
                continue;
              }

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

        const executeBatch = (planned: ReadonlyArray<PlannedCall>) =>
          Effect.gen(function* () {
            for (const { callId, tool, prepared } of planned) {
              if (untrusted && tool.withdrawnWhenUntrusted) {
                const error = withdrawnError(tool);
                const output = failureReply(error.reason, error.message);

                yield* store.finishToolCall(run.id, callId, {
                  status: "failed",
                  reason: failureReason(error),
                  output,
                });

                if (reviewedMCP(tool)) {
                  return yield* Effect.fail(error);
                }

                current.push({ role: "tool", callId, output });
                callsUsed++;
                continue;
              }

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

              const result = yield* executeTool(run, callId, tool, prepared, guard).pipe(
                Effect.map((output) => ({ output })),
                Effect.catchTag("ParkRequest", (request) =>
                  park(callId, request).pipe(Effect.map((approval) => ({ approval }))),
                ),
              );

              if ("approval" in result) {
                return result.approval;
              }

              if (tool.untrustedResult) {
                untrusted = true;
              }

              current.push({ role: "tool", callId, output: result.output });
              callsUsed++;
            }

            return null;
          });

        // Saves the approval so the run waits, leaving the call and the rest of its batch pending.
        const park = (callId: string, { approval }: ParkRequest) =>
          Effect.gen(function* () {
            const requester = runContext.approvalRequester;

            if (requester === null) {
              return yield* Effect.die(new Error("A run parked without an approval requester."));
            }

            const now = yield* Clock.currentTimeMillis;
            const defaultExpiry = now + (yield* timeoutSeconds("approvalSeconds")) * 1000;

            const expiresAt =
              runContext.approvalExpiresAt === null
                ? defaultExpiry
                : Math.min(defaultExpiry, runContext.approvalExpiresAt);

            if (expiresAt <= now) {
              return yield* Effect.fail(
                new AgentError({
                  reason:
                    approval.kind === "mcp" ? "mcp-approval-required" : "command-approval-required",
                  message: "Approval cannot wait because the next scheduled run is already due.",
                }),
              );
            }

            return yield* store.parkRun(run.id, callId, {
              kind: approval.kind,
              request: { ...approval },
              requester,
              expiresAt,
            });
          });

        // Runs the rest of a batch after a resumed call, one call at a time.
        const continueBatch = (calls: ReadonlyArray<ToolCall>) =>
          Effect.gen(function* () {
            for (const call of calls) {
              const planned = yield* prepareTool(call).pipe(Effect.result);

              if (Result.isFailure(planned)) {
                if (!preflightReported(planned.failure)) {
                  return yield* Effect.fail(planned.failure);
                }

                const output = failureReply(planned.failure.reason, planned.failure.message);

                yield* store.finishToolCall(run.id, call.callId, {
                  status: "failed",
                  reason: failureReason(planned.failure),
                  output,
                });
                current.push({ role: "tool", callId: call.callId, output });
                callsUsed++;
                continue;
              }

              const parked = yield* executeBatch([planned.success]);

              if (parked !== null) {
                return parked;
              }
            }

            return null;
          });

        // Continues a waiting run from its saved messages once the owner has decided.
        const resumeFrom = (approval: Approval): ConversationStream =>
          Stream.unwrap(
            Effect.gen(function* () {
              const saved = yield* store.toolCalls(run.id);
              const call = saved.find((entry) => entry.callId === approval.callId);
              const own = runContext.history.filter((entry) => entry.runId === run.id);

              const batch = own.findLast((entry) => entry.message.role === "assistant")?.message;

              const calls =
                batch?.role === "assistant"
                  ? batch.output.flatMap((part) => (part.type === "tool-call" ? [part] : []))
                  : [];

              const index = calls.findIndex((part) => part.callId === approval.callId);
              const part = calls[index];

              if (
                (approval.state !== "approved" && approval.state !== "denied") ||
                approval.runId !== run.id ||
                call?.status !== "pending" ||
                callDigest(call) !== approval.digest ||
                part === undefined
              ) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "invalid-request",
                    message: "The approval no longer matches a waiting call. Nothing was executed.",
                  }),
                );
              }

              current.splice(
                0,
                current.length,
                ...own.map((entry) => withMentionedSkills(entry.message)),
              );
              turns = current.filter((message) => message.role === "assistant").length;
              callsUsed = current.filter((message) => message.role === "tool").length;
              usage = null;

              for (const message of current) {
                if (message.role === "assistant") {
                  for (const output of message.output) {
                    outputBytes += output.type === "text" ? byteSize(output.text) : 0;
                  }
                }
              }

              // A finished call whose tool is gone is treated as untrusted.
              untrusted ||= saved.some(
                (entry) =>
                  (entry.status === "completed" || entry.status === "failed") &&
                  (findTool(entry)?.untrustedResult ?? true),
              );

              const tool = findTool(part);

              if (tool === undefined) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message: "The requested tool is not allowed in this run.",
                  }),
                );
              }

              if (untrusted && tool.withdrawnWhenUntrusted) {
                return yield* Effect.fail(withdrawnError(tool));
              }

              const prepared = yield* tool.prepare(part, context);

              if (!("authorize" in prepared)) {
                return yield* Effect.fail(
                  new AgentError({
                    reason: "invalid-request",
                    message: "The waiting call is no longer reviewed. Nothing was executed.",
                  }),
                );
              }

              const decided: ReviewableCall = {
                approved: prepared.approved,
                authorize: () =>
                  approval.state === "approved"
                    ? Effect.succeed(prepared.approved)
                    : Effect.fail(ownerDenied(approval.kind)),
              };

              yield* executeBatch([{ callId: part.callId, tool, prepared: decided }]);

              const parked = yield* continueBatch(calls.slice(index + 1));

              return parked === null ? turn() : waiting(parked);
            }),
          );

        return runContext.resume === null ? turn() : resumeFrom(runContext.resume);
      }),
    );
});
