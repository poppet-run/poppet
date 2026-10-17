import { Memory } from "@poppet/memory";
import type {
  Completion,
  Message,
  ModelEvent,
  ModelOperations,
  Output,
  ProviderError,
} from "@poppet/provider";
import {
  Store,
  StoreError,
  type Run,
  type StoredMessage,
  type DeliveryDestination,
} from "@poppet/store";
import { Clock, Effect, Match, Option, Stream } from "effect";

import { assembleContext, byteSize, outputBudget } from "#src/context";
import { AgentError } from "#src/errors";
import {
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
import { ChatTasks, decodeTaskCall, taskTool, type PreparedTaskCall } from "#src/task-tools";
import { WebSearch, decodeWebSearchCall, webSearchTool, type WebSearchCall } from "#src/web-search";

type ConversationEvent = ModelEvent | { readonly type: "reasoning-end" };

/** Builds the bounded model/tool loop; the caller owns the run's final outcome. */
export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const notes = yield* Notes;
  const memory = yield* Memory;
  const pages = yield* Pages;
  const webSearch = yield* WebSearch;
  const policy = yield* ChatSettings;
  const tasks = Option.getOrNull(yield* Effect.serviceOption(ChatTasks));
  const clock = yield* Clock.Clock;

  const executeTool = (
    run: Run,
    callId: string,
    call:
      | NoteCall
      | SessionSearchCall
      | SessionReadCall
      | FetchPageCall
      | MemoryCall
      | WebSearchCall
      | PreparedTaskCall,
  ) => {
    const operation = Effect.gen(function* () {
      yield* store.startToolCall(run.id, callId);
      let urls: ReadonlyArray<string> = [];

      const result: Effect.Effect<string, AgentError | StoreError> = Match.value(call).pipe(
        Match.when({ name: "search_sessions" }, (plan) =>
          store
            .searchSessions(plan.query, policy.toolBytes)
            .pipe(Effect.map((value) => JSON.stringify(value))),
        ),
        Match.when({ name: "read_session" }, (plan) =>
          store
            .readSession(plan.query, policy.toolBytes)
            .pipe(Effect.map((value) => JSON.stringify(value))),
        ),
        Match.when({ name: "fetch_page" }, (plan) => pages.fetch(plan.url)),
        Match.when({ name: "manage_tasks" }, (plan) => plan.execute),
        Match.when({ name: "search_web" }, (plan) =>
          webSearch.search === null
            ? Effect.fail(
                new AgentError({
                  reason: "tool-permission",
                  message: "Web search is unavailable.",
                }),
              )
            : webSearch.search(plan.query).pipe(
                Effect.map((value) => {
                  urls = value.results.map((item) => item.url);

                  return JSON.stringify(value);
                }),
              ),
        ),
        Match.when({ name: "memory" }, (plan) =>
          executeMemoryCall(memory, plan, run.id, policy.factsBytes),
        ),
        Match.orElse((plan) => notes.execute(plan)),
      );

      const output = yield* result.pipe(
        Effect.catch((error) =>
          store
            .finishToolCall(run.id, callId, {
              status:
                call.name === "save_note" ||
                (call.name === "manage_tasks" &&
                  error instanceof StoreError &&
                  error.reason === "storage") ||
                (call.name === "memory" && error.reason === "memory-storage")
                  ? "uncertain"
                  : "failed",
              reason: `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`,
            })
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

      if (call.name !== "manage_tasks")
        yield* store.finishToolCall(run.id, callId, { status: "completed", output });

      return { output, urls };
    });

    // Keep an atomic write and its durable result together on graceful cancellation.
    return call.name === "save_note" || call.name === "memory"
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
  ) =>
    Stream.suspend(() => {
      const tools = model.description.capabilities.tools
        ? [
            ...noteTools,
            sessionSearchTool,
            sessionReadTool,
            fetchPageTool,
            memoryTool,
            ...(webSearch.search === null ? [] : [webSearchTool]),
            ...(tasks === null || readOnlyTools ? [] : [taskTool]),
          ].filter(
            (tool) => !readOnlyTools || (tool.name !== "save_note" && tool.name !== "memory"),
          )
        : [];

      const allowedURLs = suppliedPageURLs(text);

      const instructions =
        tasks !== null && !readOnlyTools
          ? `${prompt}\nCurrent UTC time: ${new Date(clock.currentTimeMillisUnsafe()).toISOString()}. Resolve relative task times against this time. Ask for an explicit offset or IANA timezone when unclear; task prompts must be self-contained because each occurrence starts a fresh session.`
          : prompt;

      const prepareTool = (call: Extract<Output, { type: "tool-call" }>) =>
        Effect.gen(function* () {
          if (!tools.some((tool) => tool.name === call.name && tool.namespace === call.namespace))
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "The requested tool is not allowed in this run.",
              }),
            );

          const plan = yield* Match.value(call).pipe(
            Match.when({ name: "search_sessions" }, decodeSessionSearchCall),
            Match.when({ name: "read_session" }, decodeSessionReadCall),
            Match.when({ name: "memory" }, decodeMemoryCall),
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

      const current: Message[] = [{ role: "user", text }];
      let turns = 0;
      let callsUsed = 0;
      let outputBytes = 0;
      let reasoningBytes = 0;
      let usage: Completion["usage"] = { inputTokens: 0, outputTokens: 0 };

      const turn = (): Stream.Stream<ConversationEvent, AgentError | ProviderError | StoreError> =>
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
                  tools,
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

            return streamReply(
              model,
              {
                sessionId: run.sessionId,
                workload: run.workload,
                instructions,
                messages,
                tools,
                settings: policy.logReasoning ? { ...settings, reasoningSummary: true } : settings,
              },
              run,
            ).pipe(
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
                    yield* store.recordToolCalls(run.id, response);

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

                    // Validate the whole batch before any call can change notes or memory.
                    const planned = yield* Effect.forEach(calls, prepareTool);

                    current.push({
                      role: "assistant",
                      output: response.output,
                      continuation: response.continuation,
                    });

                    for (const { callId, plan } of planned) {
                      const { output, urls } = yield* executeTool(run, callId, plan);

                      for (const url of urls) allowedURLs.add(url);
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
    });
});
