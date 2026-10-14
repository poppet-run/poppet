import type {
  Completion,
  Message,
  ModelEvent,
  ModelOperations,
  ProviderError,
} from "@poppet/provider";
import { Store, type Run, type StoreError, type StoredMessage } from "@poppet/store";
import { Effect, Stream } from "effect";

import { assembleContext, byteSize, instructions, outputBudget } from "#src/context";
import { AgentError } from "#src/errors";
import { Notes, decodeNoteCall, noteTools, type NoteCall } from "#src/notes";
import { maxTextBytes, streamReply } from "#src/reply";
import { ChatSettings } from "#src/settings";

export const conversation = Effect.gen(function* () {
  const store = yield* Store;
  const notes = yield* Notes;
  const policy = yield* ChatSettings;

  const executeTool = (run: Run, callId: string, call: NoteCall) => {
    const operation = Effect.gen(function* () {
      yield* store.startToolCall(run.id, callId);

      const output = yield* notes.execute(call).pipe(
        Effect.catchTag("AgentError", (error) =>
          Effect.gen(function* () {
            yield* store.finishToolCall(run.id, callId, {
              status: call.name === "save_note" ? "uncertain" : "failed",
              reason: `agent:${error.reason}`,
            });

            return yield* Effect.fail(error);
          }),
        ),
      );

      yield* store.finishToolCall(run.id, callId, { status: "completed", output });

      return output;
    });

    // Keep an atomic write and its durable result together on graceful cancellation.
    return call.name === "save_note" ? Effect.uninterruptible(operation) : operation;
  };

  return (
    run: Run,
    model: ModelOperations,
    text: string,
    history: ReadonlyArray<StoredMessage>,
    runs: ReadonlyArray<Run>,
  ) =>
    Stream.suspend(() => {
      const tools = model.description.capabilities.tools ? noteTools : [];
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
              try: () => assembleContext(history, runs, current, model.description, policy, tools),
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

                    const planned = yield* Effect.forEach(calls, (call) => {
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

                      return decodeNoteCall(call);
                    });

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
