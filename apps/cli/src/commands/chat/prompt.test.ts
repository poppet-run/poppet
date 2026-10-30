import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { AgentError } from "@poppet/agent";
import { WorkerRequestError } from "@poppet/worker";
import { Console, Effect } from "effect";

import type { ChatCommand } from "#src/commands/chat/chat";
import { interactiveChat } from "#src/commands/chat/prompt";

describe("readChatLine", () => {
  test.concurrent("when prompts finish, releases stdin error listeners", async () => {
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
        import { readChatLine } from "./commands/chat/prompt.ts";

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
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
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
});

const fixture = (lines: (string | null)[]) => {
  let reads = 0;
  const commands: ChatCommand[] = [];
  const errors: string[] = [];
  const messages: string[] = [];

  const read = Effect.sync(() => {
    reads++;

    return lines.shift() ?? null;
  });

  return {
    commands,
    read,
    reads: () => reads,
    errors,
    messages,
    run: <A, E>(program: Effect.Effect<A, E>) =>
      Effect.runPromise(
        program.pipe(
          Effect.provideService(Console.Console, {
            ...console,
            log: (...values) => {
              messages.push(values.join(" "));
            },
            error: (...values) => {
              errors.push(values.join(" "));
            },
          }),
        ),
      ),
  };
};

describe.concurrent("interactiveChat", () => {
  test("when the first failed turn is acknowledged, continues the saved session without retrying", async () => {
    const state = fixture(["", "Fail first", "New request", "/exit"]);
    await state.run(
      interactiveChat(
        {},
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
      { action: "new", text: "Fail first" },
      { action: "send", id: "saved-session", text: "New request" },
    ]);
    expect(state.errors.join("\n")).toContain("Lost response. Not retried.");
    expect(state.messages.filter((line) => line.startsWith("Session: "))).toEqual([
      "Session: saved-session",
    ]);
  });

  test("when files are added with /attach, sends them with the next message only", async () => {
    const state = fixture([
      "/attach ./screen one.png",
      "/attach notes.md",
      "Look",
      "Again",
      "/exit",
    ]);

    await state.run(
      interactiveChat(
        {},
        (command, acknowledge) =>
          Effect.sync(() => {
            state.commands.push(command);
          }).pipe(Effect.andThen(acknowledge("saved-session"))),
        state.read,
      ),
    );

    expect(state.errors).toEqual([]);
    expect(state.messages.join("\n")).toContain("\nAttached notes.md to the next message.\n");
    expect(state.messages).toContain("\nPoppet\n");
    expect(state.commands).toEqual([
      {
        action: "new",
        text: "Look",
        attachments: ["./screen one.png", "notes.md"],
      },
      { action: "send", id: "saved-session", text: "Again" },
    ]);
  });

  test("when a failed request is unacknowledged, stops without creating another session", async () => {
    const state = fixture(["First request", "Must not send"]);

    const result = await state.run(
      interactiveChat(
        {},
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

  test.each(["output", "session"])("when %s fails, stops the chat loop", async (failure) => {
    const state = fixture(["Send", "Must not send"]);

    const result = await state.run(
      interactiveChat(
        { sessionId: "saved-session" },
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

  test.each([null, "/exit"])("when input is %j, exits without a request", async (line) => {
    const state = fixture([line]);
    await state.run(interactiveChat({}, () => Effect.die("Must not submit"), state.read));
    expect(state.reads()).toBe(1);
  });

  test.each([{ skill: "review" }])(
    "when resuming with selection changes, rejects them before reading input",
    async (selection) => {
      const state = fixture([]);

      const result = await state.run(
        interactiveChat(
          { ...selection, sessionId: "saved-session" },
          () => Effect.die("Must not submit"),
          state.read,
        ).pipe(Effect.result),
      );

      expect(result).toHaveProperty("failure.message", expect.stringContaining("saved skill"));
      expect(state.reads()).toBe(0);
    },
  );
});
