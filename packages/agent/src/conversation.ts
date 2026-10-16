import { Memory } from "@poppet/memory";
import type {
  Completion,
  Message,
  ModelEvent,
  ModelOperations,
  ProviderError,
} from "@poppet/provider";
import { Store, type Run, type StoreError, type StoredMessage } from "@poppet/store";
import { Effect, Match, Stream } from "effect";

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
import { decodeSessionSearchCall, sessionSearchTool, type SessionSearchCall } from "#src/search";
import { ChatSettings } from "#src/settings";

/** Builds the bounded model/tool loop; the caller owns the run's final outcome. */
export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const notes = yield* Notes;
  const memory = yield* Memory;
  const pages = yield* Pages;
  const policy = yield* ChatSettings;

  const executeTool = (
    run: Run,
    callId: string,
    call: NoteCall | SessionSearchCall | FetchPageCall | MemoryCall,
  ) => {
    const operation = Effect.gen(function* () {
      yield* store.startToolCall(run.id, callId);

      const result: Effect.Effect<string, AgentError | StoreError> = Match.value(call).pipe(
        Match.when({ name: "search_sessions" }, (plan) =>
          store
            .searchSessions(plan.query, policy.toolBytes)
            .pipe(Effect.map((value) => JSON.stringify(value))),
        ),
        Match.when({ name: "fetch_page" }, (plan) => pages.fetch(plan.url)),
        Match.when({ name: "memory" }, (plan) =>
          executeMemoryCall(memory, plan, run.id, policy.factsBytes),
        ),
        Match.orElse((plan) => notes.execute(plan)),
      );

      const output = yield* result.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* store.finishToolCall(run.id, callId, {
              status:
                call.name === "save_note" ||
                (call.name === "memory" && error.reason === "memory-storage")
                  ? "uncertain"
                  : "failed",
              reason: `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`,
            });

            return yield* Effect.fail(error);
          }),
        ),
      );

      yield* store.finishToolCall(run.id, callId, { status: "completed", output });

      return output;
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
  ) =>
    Stream.suspend(() => {
      const tools = model.description.capabilities.tools
        ? [...noteTools, sessionSearchTool, fetchPageTool, memoryTool].filter(
            (tool) => !readOnlyTools || (tool.name !== "save_note" && tool.name !== "memory"),
          )
        : [];

      const allowedURLs = suppliedPageURLs(text);
      const current: Message[] = [{ role: "user", text }];
      let turns = 0;
      let callsUsed = 0;
      let outputBytes = 0;
      let usage: Completion["usage"] = { inputTokens: 0, outputTokens: 0 };

      const turn = (): Stream.Stream<ModelEvent, AgentError | ProviderError | StoreError> =>
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
                assembleContext(history, runs, current, model.description, policy, tools, prompt),
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
                instructions: prompt,
                messages,
                tools,
                settings,
              },
              run,
            ).pipe(
              Stream.flatMap((event) => {
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

                return Stream.unwrap(
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
                    const planned = yield* Effect.forEach(
                      calls,
                      (
                        call,
                      ): Effect.Effect<
                        NoteCall | SessionSearchCall | FetchPageCall | MemoryCall,
                        AgentError
                      > => {
                        if (
                          !tools.some(
                            (tool) => tool.name === call.name && tool.namespace === call.namespace,
                          )
                        )
                          return Effect.fail(
                            new AgentError({
                              reason: "tool-permission",
                              message: "The requested tool is not allowed in this run.",
                            }),
                          );

                        return Match.value(call).pipe(
                          Match.when({ name: "search_sessions" }, decodeSessionSearchCall),
                          Match.when({ name: "memory" }, decodeMemoryCall),
                          Match.when({ name: "fetch_page" }, (plan) =>
                            decodeFetchPageCall(plan, allowedURLs),
                          ),
                          Match.orElse(decodeNoteCall),
                        );
                      },
                    );

                    current.push({
                      role: "assistant",
                      output: response.output,
                      continuation: response.continuation,
                    });

                    for (const [index, call] of calls.entries()) {
                      const plan = planned[index];

                      if (!plan)
                        return yield* Effect.fail(
                          new AgentError({
                            reason: "protocol",
                            message: "The tool-call plan is incomplete.",
                          }),
                        );
                      const output = yield* executeTool(run, call.callId, plan);
                      current.push({ role: "tool", callId: call.callId, output });
                      callsUsed++;
                    }

                    return turn();
                  }),
                );
              }),
            );
          }),
        );

      return turn();
    });
});
