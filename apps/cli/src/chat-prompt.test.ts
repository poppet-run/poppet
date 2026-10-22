import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { AgentError } from "@poppet/agent";
import { WorkerRequestError } from "@poppet/worker";
import { Console, Effect } from "effect";

import type { ChatCommand } from "#src/chat";
import { interactiveChat } from "#src/chat-prompt";

test.concurrent("readline releases stdin error listeners after completed prompts", async () => {
  let transcript = "";
  let prompts = 0;
  const input = ["first\n", "second\n", "\u0004"];
  const decoder = new TextDecoder();
  const finished = Promise.withResolvers<string>();

  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { Effect } from "effect";
        import { readChatLine } from "./chat-prompt.ts";

        const before = process.stdin.listenerCount("error");
        const results = await Effect.runPromise(Effect.gen(function* () {
          const results = [];
          for (let index = 0; index < 3; index++) {
            const text = yield* readChatLine;
            results.push({ text, listeners: process.stdin.listenerCount("error") - before });
          }
          return results;
        }));
        console.log("RESULT " + JSON.stringify(results));
      `,
    ],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", TERM: "dumb", NO_COLOR: "1" },
      terminal: {
        data(terminal, data) {
          transcript += decoder.decode(data, { stream: true });
          const count = transcript.split("You> ").length - 1;

          while (prompts < count && prompts < input.length) terminal.write(input[prompts++]!);
        },
        exit: () => finished.resolve(transcript),
      },
    },
  );

  try {
    const [exitCode, output] = await Effect.runPromise(
      Effect.promise(() => Promise.all([child.exited, finished.promise])).pipe(
        Effect.timeout("2 seconds"),
      ),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.match(/RESULT (.+)/)?.[1] ?? "null")).toEqual([
      { text: "first", listeners: 0 },
      { text: "second", listeners: 0 },
      { text: null, listeners: 0 },
    ]);
  } finally {
    child.kill("SIGKILL");
    child.terminal?.close();
    await child.exited;
  }
});

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

  test("stops after an unacknowledged failed request instead of creating another session", async () => {
    const state = fixture(["First request", "Must not send"]);

    const result = await state.run(
      interactiveChat(
        { coding: false },
        (command) => {
          state.commands.push(command);

          return Effect.fail(new WorkerRequestError({ message: "Lost response" }));
        },
        state.read,
      ).pipe(Effect.result),
    );

    expect(result).toHaveProperty("failure.message", expect.stringContaining("Lost response"));
    expect(state.commands).toHaveLength(1);
    expect(state.reads()).toBe(1);
  });

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

  test.each([
    { coding: true },
    { coding: false, skill: "review" },
    { coding: false, project: "acorn" },
  ])("rejects resume selection changes before reading input", async (selection) => {
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
      expect.stringContaining("saved workload, skill and project"),
    );
    expect(state.reads()).toBe(0);
  });
});
