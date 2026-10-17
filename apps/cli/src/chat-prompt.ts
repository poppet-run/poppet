import { createInterface } from "node:readline";

import { AgentError } from "@poppet/agent";
import { Console, Effect, Result, Semaphore } from "effect";

import {
  writeChatText,
  type ChatCommand,
  type ChatWriter,
  type ChatReasoningWriter,
} from "#src/chat";

const inputFailure = () =>
  new AgentError({ reason: "interrupted", message: "Could not read the interactive chat prompt." });

const terminalColumns = () => Math.max(1, process.stderr.columns ?? 80);

const thinkingPalette = [66, 73, 80, 116, 152, 159, 195, 231];

/** Sweeps a cyan highlight across a fixed label, resetting styling after each frame. */
export const thinkingIndicator = (frame: number, glow: boolean, columns = terminalColumns()) => {
  if (!glow) return `Thinking${".".repeat((Math.floor(frame / 3) % 3) + 1)}`.slice(0, columns);
  const label = "Thinking...".slice(0, columns);
  const center = ((frame / 2) % (label.length + 6)) - 3;

  return (
    "\u001b[0m" +
    Array.from(label, (character, index) => {
      const strength = Math.max(0, 1 - Math.abs(index - center) / 3);
      const color = thinkingPalette[Math.round(strength * (thinkingPalette.length - 1))];

      return `\u001b[38;5;${color}m${character}`;
    }).join("") +
    "\u001b[0m"
  );
};

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

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => createInterface({ input: process.stdin, output: process.stdout, terminal: true }),
      catch: inputFailure,
    }),
    (reader) =>
      Effect.callback<string | null, AgentError>((resume) => {
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
      }),
    (reader) => Effect.sync(() => reader.close()),
  );
});

export interface InteractiveChatOptions {
  readonly sessionId?: string | undefined;
  readonly coding: boolean;
  readonly skill?: string | undefined;
}

/** Keeps streamed thinking readable while answer text stays on its existing output. */
export const interactiveChatOutput = (
  write: ChatWriter,
  thinking: ChatWriter,
  animate = process.stderr.isTTY === true && process.env.TERM !== "dumb",
  glow = !process.env.NO_COLOR && (process.stderr.hasColors?.(256) ?? false),
) =>
  Effect.gen(function* () {
    const terminal = yield* Semaphore.make(1);
    let open = false;
    let waiting = true;
    let visible = false;
    let frame = 0;
    let line = "";
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

    // Repaint only the last visual row, leaving earlier reasoning in scrollback.
    const rememberLine = (text: string) => {
      let row = "";
      let width = 0;

      for (const { segment } of segments.segment(line + text)) {
        if (segment.includes("\n")) {
          row = "";
          width = 0;
          continue;
        }

        const size = Bun.stringWidth(segment);

        if (width + size > terminalColumns()) {
          row = "";
          width = 0;
        }

        row += segment;
        width += size;
      }

      line = row;
    };

    const clear = Effect.suspend(() => {
      if (!visible) return Effect.void;
      visible = false;

      return thinking(`\r\u001b[2K${open ? `\u001b[1A\r\u001b[2K${line}` : ""}`);
    });

    const finishReasoning = Effect.gen(function* () {
      if (open) {
        open = false;
        line = "";
        yield* thinking("\n\n");
      }
    });

    const stop = Effect.gen(function* () {
      waiting = false;
      yield* clear;
      yield* finishReasoning;
    });

    const render = Effect.suspend(() => {
      if (!animate || !waiting) return Effect.void;
      const prefix = !visible && open ? "\r\n" : "\r\u001b[2K";
      visible = true;
      const label = thinkingIndicator(frame++, glow);

      return thinking(prefix + label);
    });

    const close = terminal.withPermit(stop);
    yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));

    if (animate)
      yield* Effect.gen(function* () {
        for (;;) {
          if (!waiting) return;
          yield* terminal.withPermit(render);
          yield* Effect.sleep("100 millis");
        }
      }).pipe(Effect.ignore, Effect.forkScoped({ startImmediately: true }));

    const reasoning: ChatReasoningWriter = (event) =>
      terminal.withPermit(
        Effect.gen(function* () {
          if (event.type === "reasoning-end") {
            if (open) {
              yield* clear;
              yield* finishReasoning;
              yield* render;
            }

            return;
          }

          if (event.text.length === 0) return;
          yield* clear;

          if (!open) {
            yield* thinking("Thinking:\n");
            open = true;
          }

          yield* thinking(event.text);

          if (animate) rememberLine(event.text);
          yield* render;
        }),
      );

    return {
      answer: (text: string) =>
        text.length === 0
          ? Effect.void
          : terminal.withPermit(stop.pipe(Effect.andThen(write(text)))),
      announce: (text: string) =>
        terminal.withPermit(clear.pipe(Effect.andThen(Console.error(text)))),
      reasoning,
    };
  });

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

    const acknowledgeSession: ChatWriter = (id) =>
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
      });

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

      const result = yield* send(command, acknowledgeSession).pipe(Effect.result);

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
