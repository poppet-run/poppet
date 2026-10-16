import { createInterface } from "node:readline";

import { AgentError } from "@poppet/agent";
import { Console, Effect, Result } from "effect";

import { writeChatText, type ChatCommand, type ChatWriter } from "#src/chat";

const inputFailure = () =>
  new AgentError({ reason: "interrupted", message: "Could not read the interactive chat prompt." });

/** One line owns readline only while waiting; inference keeps normal terminal signal handling. */
export const readChatLine = Effect.suspend(() => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return Effect.fail(
      new AgentError({
        reason: "invalid-request",
        message:
          "Interactive chat requires a terminal. Use chat new or chat send for one-shot requests.",
      }),
    );

  return Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            createInterface({ input: process.stdin, output: process.stdout, terminal: true }),
          catch: inputFailure,
        }),
        (owned) => Effect.sync(() => owned.close()),
      );

      return yield* Effect.callback<string | null, AgentError>((resume) => {
        const close = () => resume(writeChatText("\n").pipe(Effect.as(null)));
        const fail = () => resume(Effect.fail(inputFailure()));
        reader.once("close", close);
        reader.once("SIGINT", close);
        process.stdin.once("error", fail);

        try {
          reader.question("You> ", (line) => resume(Effect.succeed(line)));
        } catch {
          fail();
        }

        return Effect.sync(() => {
          reader.off("close", close);
          reader.off("SIGINT", close);
          process.stdin.off("error", fail);
        });
      });
    }),
  );
});

export interface InteractiveChatOptions {
  readonly sessionId?: string | undefined;
  readonly coding: boolean;
  readonly skill?: string | undefined;
}

/** Reuses one saved session, including after a failed turn whose identity was already acknowledged. */
export const interactiveChat = <E extends { readonly message: string }, R>(
  options: InteractiveChatOptions,
  send: (
    command: Extract<ChatCommand, { action: "new" | "send" }>,
    onSession: ChatWriter,
  ) => Effect.Effect<void, E, R>,
  read: Effect.Effect<string | null, AgentError> = readChatLine,
) =>
  Effect.gen(function* () {
    if (options.sessionId !== undefined && (options.coding || options.skill !== undefined))
      return yield* Effect.fail(
        new AgentError({
          reason: "invalid-request",
          message:
            "A resumed session keeps its saved workload and skill. Omit --coding and --skill.",
        }),
      );

    let sessionId = options.sessionId;
    yield* Console.error(
      "Enter one message per line. /exit or Ctrl-D leaves the prompt; Ctrl-C cancels and exits.",
    );

    for (;;) {
      const text = yield* read;

      if (text === null || text.trim() === "/exit") return;

      if (text.trim().length === 0) continue;

      const command =
        sessionId !== undefined
          ? { action: "send" as const, id: sessionId, text }
          : options.skill === undefined
            ? { action: "new" as const, coding: options.coding, text }
            : { action: "new" as const, coding: options.coding, skill: options.skill, text };

      const result = yield* send(command, (id) =>
        Effect.suspend(() => {
          if (sessionId !== undefined && sessionId !== id)
            return Effect.fail(
              new AgentError({
                reason: "interrupted",
                message: "The chat returned a different session. The prompt has stopped.",
              }),
            );
          sessionId = id;

          return Effect.void;
        }),
      ).pipe(Effect.result);

      if (Result.isFailure(result)) {
        if (
          sessionId === undefined ||
          (result.failure instanceof AgentError && result.failure.reason === "interrupted")
        )
          return yield* Effect.fail(result.failure);
        yield* Console.error(`\n${result.failure.message}`);
      } else if (sessionId === undefined)
        return yield* Effect.fail(
          new AgentError({
            reason: "invalid-request",
            message:
              "The worker did not return a session identity. Inspect the printed session ID and restart the worker before continuing. The request was not retried.",
          }),
        );
    }
  });
