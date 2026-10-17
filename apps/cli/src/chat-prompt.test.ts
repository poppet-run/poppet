import { describe, expect, test } from "bun:test";

import { AgentError } from "@poppet/agent";
import { WorkerRequestError } from "@poppet/worker";
import { Console, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { ChatCommand } from "#src/chat";
import { interactiveChat, interactiveChatOutput, thinkingIndicator } from "#src/chat-prompt";

const fixture = (lines: (string | null)[]) => {
  let reads = 0;
  const commands: ChatCommand[] = [];
  const errors: string[] = [];

  const read = Effect.sync(() => {
    reads++;

    return lines.shift() ?? null;
  });

  return {
    commands,
    read,
    reads: () => reads,
    errors,
    run: <A, E>(program: Effect.Effect<A, E>) =>
      Effect.runPromise(
        program.pipe(
          Effect.provideService(Console.Console, {
            ...console,
            error: (...values) => {
              errors.push(values.join(" "));
            },
          }),
        ),
      ),
  };
};

describe.concurrent("interactive chat indicator", () => {
  const update = expect.stringContaining("\r\u001b[2KThinking");
  const belowReasoning = expect.stringContaining("\r\nThinking");

  test("moves a cyan highlight without changing the label width or leaking colour", () => {
    const frames = [0, 6, 16, 26].map((frame) => thinkingIndicator(frame, true));
    expect(new Set(frames).size).toBe(frames.length);

    for (const frame of frames) {
      expect(Bun.stripANSI(frame)).toBe("Thinking...");
      expect(frame).toContain("\u001b[38;5;");
      expect(frame.endsWith("\u001b[0m")).toBe(true);
    }

    expect(Bun.stripANSI(thinkingIndicator(6, true, 4))).toBe("Thin");
    expect([0, 3, 6].map((frame) => thinkingIndicator(frame, false))).toEqual([
      "Thinking.",
      "Thinking..",
      "Thinking...",
    ]);
  });

  test.each(["reasoning", "answer"])(
    "animates around announcements and alongside %s text until the answer",
    async (first) => {
      const events: string[] = [];
      const write = (text: string) => Effect.sync(() => events.push(text)).pipe(Effect.asVoid);

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const output = yield* interactiveChatOutput(write, write, true);
            expect(events).toEqual([update]);
            yield* TestClock.adjust("300 millis");
            expect(events.at(-1)).toEqual(update);
            yield* output.announce("Run: saved-run");
            expect(events.slice(-2)).toEqual(["\r\u001b[2K", "Run: saved-run"]);
            yield* TestClock.adjust("300 millis");
            expect(events.at(-1)).toEqual(update);

            // Empty provider events and tool boundaries must not hide a pending request.
            yield* output.reasoning({ type: "reasoning-end" });
            yield* output.reasoning({ type: "reasoning-delta", text: "" });
            yield* output.answer("");
            yield* TestClock.adjust("300 millis");
            expect(events.at(-1)).toEqual(update);

            if (first === "reasoning") {
              yield* output.reasoning({ type: "reasoning-delta", text: "Checking " });
              expect(events.slice(-4)).toEqual([
                "\r\u001b[2K",
                "Thinking:\n",
                "Checking ",
                belowReasoning,
              ]);
              yield* TestClock.adjust("300 millis");
              expect(events.at(-1)).toEqual(update);
              yield* output.reasoning({ type: "reasoning-delta", text: "dependencies." });
              expect(events.slice(-3)).toEqual([
                "\r\u001b[2K\u001b[1A\r\u001b[2KChecking ",
                "dependencies.",
                belowReasoning,
              ]);
              yield* output.reasoning({ type: "reasoning-end" });
              expect(events.slice(-3)).toEqual([
                "\r\u001b[2K\u001b[1A\r\u001b[2KChecking dependencies.",
                "\n\n",
                update,
              ]);
              yield* TestClock.adjust("300 millis");
              expect(events.at(-1)).toEqual(update);
              yield* output.answer("13 minutes.\n");
              expect(events.slice(-2)).toEqual(["\r\u001b[2K", "13 minutes.\n"]);
            } else {
              yield* output.answer("13 minutes.\n");
              expect(events.slice(-2)).toEqual(["\r\u001b[2K", "13 minutes.\n"]);
            }

            const count = events.length;
            yield* TestClock.adjust("1 second");
            expect(events).toHaveLength(count);
          }),
        ).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(Console.Console, {
            ...console,
            error: (text) => events.push(text),
          }),
        ),
      );
    },
  );

  test.each([
    { outcome: "failure", reasoning: false },
    { outcome: "failure", reasoning: true },
    { outcome: "cancellation", reasoning: false },
    { outcome: "cancellation", reasoning: true },
  ])(
    "clears the indicator after $outcome with reasoning=$reasoning",
    async ({ outcome, reasoning }) => {
      const events: string[] = [];
      const write = (text: string) => Effect.sync(() => events.push(text)).pipe(Effect.asVoid);

      await Effect.runPromise(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();

          const running = yield* Effect.scoped(
            Effect.gen(function* () {
              const output = yield* interactiveChatOutput(write, write, true);

              if (reasoning)
                yield* output.reasoning({
                  type: "reasoning-delta",
                  text: "Checking dependencies.",
                });

              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(finish);

              return yield* Effect.fail(
                new AgentError({ reason: "interrupted", message: "Failed" }),
              );
            }),
          ).pipe(Effect.forkChild);

          yield* Deferred.await(ready);
          expect(events.at(-1)).toEqual(reasoning ? belowReasoning : update);

          if (outcome === "failure") {
            yield* Deferred.succeed(finish, undefined);
            expect(yield* Fiber.join(running).pipe(Effect.result)).toHaveProperty(
              "failure.message",
              "Failed",
            );
          } else yield* Fiber.interrupt(running);

          if (reasoning)
            expect(events.slice(-2)).toEqual([
              "\r\u001b[2K\u001b[1A\r\u001b[2KChecking dependencies.",
              "\n\n",
            ]);
          else expect(events.at(-1)).toBe("\r\u001b[2K");
          const count = events.length;
          yield* TestClock.adjust("1 second");
          expect(events).toHaveLength(count);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  test.each(["wrapped", "wide", "exact-width"])(
    "preserves the last reasoning row when text is %s",
    async (wrapping) => {
      const events: string[] = [];
      const write = (text: string) => Effect.sync(() => events.push(text)).pipe(Effect.asVoid);
      const columns = Math.max(1, process.stderr.columns ?? 80);
      const prefix = "x".repeat(wrapping === "wide" ? columns - 1 : columns);
      let tail = "";

      if (wrapping === "wide") tail = "界👩‍💻";
      else if (wrapping === "wrapped") tail = "Last row";

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const output = yield* interactiveChatOutput(write, write, true);
            yield* output.reasoning({ type: "reasoning-delta", text: prefix + tail });
            events.length = 0;
            yield* output.reasoning({ type: "reasoning-delta", text: "." });
            expect(events[0]).toBe(`\r\u001b[2K\u001b[1A\r\u001b[2K${tail || prefix}`);
            expect(events[1]).toBe(".");
            expect(events[2]).toEqual(belowReasoning);
            yield* output.answer("Answer\n");
            expect(events.slice(-2)).toEqual(["\n\n", "Answer\n"]);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  test("omits the indicator when animation is disabled", async () => {
    const events: string[] = [];
    const write = (text: string) => Effect.sync(() => events.push(text)).pipe(Effect.asVoid);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const output = yield* interactiveChatOutput(write, write, false);
          yield* TestClock.adjust("1 second");
          expect(events).toEqual([]);
          yield* output.answer("13 minutes.\n");
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(events).toEqual(["13 minutes.\n"]);
  });
});

describe.concurrent("interactive chat loop", () => {
  test("continues an acknowledged failed first turn without creating another session or retrying it", async () => {
    const state = fixture(["", "Fail first", "New request", "/exit"]);
    await state.run(
      interactiveChat(
        { coding: false },
        (command, acknowledge) =>
          Effect.gen(function* () {
            state.commands.push(command);
            yield* acknowledge("saved-session");

            if (state.commands.length === 1)
              return yield* Effect.fail(
                new WorkerRequestError({ message: "Lost response. Not retried." }),
              );
          }),
        state.read,
      ),
    );
    expect(state.commands).toEqual([
      { action: "new", coding: false, text: "Fail first" },
      { action: "send", id: "saved-session", text: "New request" },
    ]);
    expect(state.errors.join("\n")).toContain("Lost response. Not retried.");
  });

  test.each(["failed", "old-worker"])(
    "stops after an unacknowledged %s request instead of creating another session",
    async (outcome) => {
      const state = fixture(["First request", "Must not send"]);

      const result = await state.run(
        interactiveChat(
          { coding: false },
          (command) => {
            state.commands.push(command);

            return outcome === "failed"
              ? Effect.fail(new WorkerRequestError({ message: "Lost response" }))
              : Effect.void;
          },
          state.read,
        ).pipe(Effect.result),
      );

      expect(result).toHaveProperty(
        "failure.message",
        expect.stringContaining(outcome === "failed" ? "Lost response" : "restart the worker"),
      );
      expect(state.commands).toHaveLength(1);
      expect(state.reads()).toBe(1);
    },
  );

  test.each(["output", "session"])("stops on %s failure", async (failure) => {
    const state = fixture(["Send", "Must not send"]);

    const result = await state.run(
      interactiveChat(
        { sessionId: "saved-session", coding: false },
        (_command, acknowledge) =>
          failure === "output"
            ? Effect.fail(new AgentError({ reason: "interrupted", message: "Output closed" }))
            : acknowledge("different-session"),
        state.read,
      ).pipe(Effect.result),
    );

    expect(result).toHaveProperty("failure.reason", "interrupted");
    expect(state.reads()).toBe(1);
  });

  test.each([null, "/exit"])("%s exits without a request", async (line) => {
    const state = fixture([line]);
    await state.run(
      interactiveChat({ coding: false }, () => Effect.die("Must not submit"), state.read),
    );
    expect(state.reads()).toBe(1);
  });

  test.each([{ coding: true }, { coding: false, skill: "review" }])(
    "rejects resume selection changes before reading input",
    async (selection) => {
      const state = fixture([]);

      const result = await state.run(
        interactiveChat(
          { ...selection, sessionId: "saved-session" },
          () => Effect.die("Must not submit"),
          state.read,
        ).pipe(Effect.result),
      );

      expect(result).toHaveProperty(
        "failure.message",
        expect.stringContaining("saved workload and skill"),
      );
      expect(state.reads()).toBe(0);
    },
  );
});
