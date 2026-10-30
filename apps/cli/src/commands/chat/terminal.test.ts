import { describe, expect, jest, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { WorkerRequestError } from "@poppet/worker";
import { Console, Effect } from "effect";

import type { ChatCommand } from "#src/commands/chat/chat";
import { interactiveChat } from "#src/commands/chat/prompt";
import { ChatTerminal } from "#src/commands/chat/terminal";

const fixture = (color = false) => {
  let frame = "";
  let exits = 0;

  const output = {
    columns: 50,
    rows: 18,
    hasColors: () => true,
    // SAFETY: the fake writer accepts the string frames used by ChatTerminal.
    write: ((text: string) => {
      frame = text;

      return true;
    }) as NodeJS.WriteStream["write"],
  };

  const terminal = new ChatTerminal(
    output,
    () => {
      exits++;
    },
    color,
  );

  return {
    terminal,
    output,
    exits: () => exits,
    frame: () => frame,
    screen: () => {
      terminal.render();

      return stripVTControlCharacters(frame);
    },
  };
};

describe("ChatTerminal", () => {
  test.each([false, true])(
    "animates thinking and responding with colour=%j and stops on completion, errors, and exit",
    async (color) => {
      jest.useFakeTimers();
      const { terminal, frame, screen } = fixture(color);

      try {
        Effect.runSync(terminal.begin("Hello"));
        terminal.input("next draft");
        screen();
        const first = frame();
        jest.advanceTimersByTime(350);
        expect(frame()).not.toBe(first);
        expect(stripVTControlCharacters(frame())).toContain("next draft");
        expect(stripVTControlCharacters(frame())).toContain("Thinking");
        expect(frame().includes("\u001b[38;5;")).toBe(color);
        Effect.runSync(terminal.answer(""));
        jest.advanceTimersByTime(350);
        expect(stripVTControlCharacters(frame())).toContain("Thinking");
        Effect.runSync(terminal.answer("Hello back"));
        jest.advanceTimersByTime(20);
        const answered = frame();
        jest.advanceTimersByTime(400);
        expect(frame()).not.toBe(answered);
        expect(stripVTControlCharacters(frame())).toContain("Responding");
        expect(stripVTControlCharacters(frame())).not.toContain("Thinking");
        expect(stripVTControlCharacters(frame())).toContain("next draft");
        expect(frame().includes("\u001b[38;5;")).toBe(color);
        const read = Effect.runPromise(terminal.read);
        jest.advanceTimersByTime(20);
        const completed = frame();
        jest.advanceTimersByTime(400);
        expect(frame()).toBe(completed);
        expect(stripVTControlCharacters(frame())).toContain("Ready");
        terminal.input("\r");
        await read;
        Effect.runSync(terminal.begin("Again"));
        expect(screen()).toContain("Thinking");
        Effect.runSync(terminal.answer("Partial answer"));
        Effect.runSync(terminal.error("Unavailable"));
        jest.advanceTimersByTime(20);
        const failed = frame();
        jest.advanceTimersByTime(400);
        expect(frame()).toBe(failed);
        expect(stripVTControlCharacters(frame())).toContain("Request failed");
        Effect.runSync(terminal.begin("Last try"));
        Effect.runSync(terminal.answer("Another answer"));
        terminal.close();
        const closed = frame();
        jest.advanceTimersByTime(400);
        expect(frame()).toBe(closed);
      } finally {
        terminal.close();
        jest.useRealTimers();
      }
    },
  );

  test("service diagnostics enter the conversation without writing over the input cursor", () => {
    const { terminal, frame, screen } = fixture(true);
    const directWrites: unknown[][] = [];

    const base = {
      ...console,
      error: (...values: unknown[]) => {
        directWrites.push(values);
      },
    };

    try {
      Effect.runSync(terminal.begin("Hello"));
      terminal.input("my next draft");
      screen();
      const before = frame();
      Effect.runSync(
        Console.error(
          "Optional session naming failed; the saved answer and fallback title are unchanged.",
        ).pipe(Effect.provideService(Console.Console, terminal.console(base))),
      );
      expect(directWrites).toEqual([]);
      expect(frame()).toBe(before);
      expect(screen()).toContain("Optional session naming failed");
      expect(screen()).toContain("my next draft");
      expect(frame()).not.toContain("\u001b[31m");
    } finally {
      terminal.close();
    }
  });

  test("queues edited messages in order while streaming and preserves a separate draft through resize", async () => {
    const { terminal, output, screen } = fixture();

    try {
      const first = Effect.runPromise(terminal.read);
      terminal.input("Hello\r");
      expect(await first).toEqual({ text: "Hello", attachments: [] });
      Effect.runSync(terminal.begin("Hello"));
      terminal.input("next\u001b[D\u007fX");
      Effect.runSync(terminal.answer("First part"));
      terminal.input("\r");
      terminal.input("third\runfinished draft");
      Effect.runSync(terminal.answer(" and second part"));
      expect(screen()).toContain("First part and second part");
      expect(screen()).toContain("1. neXt");
      expect(screen()).toContain("2. third");
      expect(screen()).toContain("unfinished draft");
      expect(screen()).not.toContain("Draft below");
      output.columns = 24;
      output.rows = 12;
      const lines = screen().split("\r\n");
      expect(lines).toHaveLength(12);
      expect(lines.every((line) => Bun.stringWidth(line) <= 23)).toBe(true);

      const second = Effect.runPromise(terminal.read);
      expect(await second).toEqual({ text: "neXt", attachments: [] });
      expect(await Effect.runPromise(terminal.read)).toEqual({ text: "third", attachments: [] });
      const fourth = Effect.runPromise(terminal.read);
      terminal.input("\r");
      expect(await fourth).toEqual({ text: "unfinished draft", attachments: [] });
    } finally {
      terminal.close();
    }
  });

  test.each(["retry", "resume"])(
    "pauses queued turns after failure and %s keeps session, order, and attachments",
    async (action) => {
      const { terminal, output, screen } = fixture();
      output.rows = 30;
      const started = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const release = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const failed = Promise.withResolvers<void>();
      const commands: ChatCommand[] = [];
      const total = action === "retry" ? 4 : 3;

      const program = interactiveChat(
        {},
        (command, acknowledge) =>
          Effect.gen(function* () {
            const index = commands.length;
            commands.push(command);
            yield* acknowledge("saved-session");
            started[index]!.resolve();
            yield* Effect.promise(() => release[index]!.promise);

            if (index === 0)
              return yield* Effect.fail(new WorkerRequestError({ message: "Try again later" }));
            yield* terminal.answer(`Answer ${index}`);
          }),
        Effect.suspend(() => (commands.length === total ? Effect.succeed(null) : terminal.read)),
        {
          welcome: terminal.welcome,
          session: terminal.session,
          begin: terminal.begin,
          info: terminal.info,
          error: (text) =>
            terminal.error(text).pipe(Effect.andThen(Effect.sync(() => failed.resolve()))),
          finish: Effect.void,
        },
      );

      const done = Effect.runPromise(program.pipe(Effect.timeout("2 seconds")));

      try {
        terminal.input("/attach first.md\rFirst\r");
        await started[0]!.promise;
        terminal.input("/attach removed.md\rRemove me\r/attach second.md\rSecond\rThird\r");
        terminal.input("/queue remove 1\r/attach draft.md\rstill drafting");
        expect(commands).toHaveLength(1);
        expect(screen()).toContain("1. [1 attached] Second");
        expect(screen()).not.toContain("Remove me");
        release[0]!.resolve();
        await failed.promise;
        // Let the prompt reach its next read. It must wait for an explicit queue action.
        await Effect.runPromise(Effect.yieldNow);
        expect(commands).toHaveLength(1);
        expect(screen()).toContain("Queue paused");
        terminal.input(`\u0015/queue ${action}\r`);

        for (let index = 1; index < total; index++) {
          // Each turn must finish before the next one starts.
          // oxlint-disable-next-line no-await-in-loop
          await started[index]!.promise;
          expect(commands).toHaveLength(index + 1);
          release[index]!.resolve();
        }

        await done;
        expect(commands).toEqual([
          { action: "new", text: "First", attachments: ["first.md"] },
          ...(action === "retry"
            ? [
                {
                  action: "send" as const,
                  id: "saved-session",
                  text: "First",
                  attachments: ["first.md"],
                },
              ]
            : []),
          { action: "send", id: "saved-session", text: "Second", attachments: ["second.md"] },
          { action: "send", id: "saved-session", text: "Third" },
        ]);
        expect(screen()).not.toContain("Queued");
        expect(screen()).toContain("1 attached");
      } finally {
        release.forEach((gate) => gate.resolve());
        terminal.close();
        await done.catch(() => {});
      }
    },
  );

  test.each(["\u001b[13;2u", "\u001b[27;2;13~", "\u001b[13;66u"])(
    "Shift+Enter %j inserts a newline without submitting, including split reports",
    async (key) => {
      const { terminal } = fixture();

      try {
        const read = Effect.runPromise(terminal.read);
        terminal.input("first" + key.slice(0, 4));
        terminal.input(key.slice(4) + "second");
        // Ctrl-A and Ctrl-E still edit; neither encoding of Ctrl-J inserts a newline.
        terminal.input("\u001b[97;5u!\u001b[101;5u\n\u001b[106;5uend\r");
        expect(await read).toEqual({ text: "!first\nsecondend", attachments: [] });
      } finally {
        terminal.close();
      }
    },
  );

  test("buffers bracketed multiline paste across chunks without submitting it, and recalls history", async () => {
    const { terminal, screen } = fixture();

    try {
      const read = Effect.runPromise(terminal.read);
      terminal.input("\u001b[20");
      terminal.input("0~first\r\nsecond\n/exit\u001b[20");
      terminal.input("1~");
      expect(screen()).toContain("second");
      terminal.input("\u001b[13;2ulast\r");
      expect(await read).toEqual({ text: "first\nsecond\n/exit\nlast", attachments: [] });

      const next = Effect.runPromise(terminal.read);
      terminal.input("draft\u001b[A");
      expect(screen()).toContain("second");
      terminal.input("\u001b[B\r");
      expect(await next).toEqual({ text: "draft", attachments: [] });
    } finally {
      terminal.close();
    }
  });

  test("loads earlier messages into the scrollable conversation without starting a turn", () => {
    const { terminal, screen } = fixture();

    try {
      const history = Array.from({ length: 30 }, (_, index) => ({
        role: "user" as const,
        text: `Earlier message ${index}`,
      }));

      Effect.runSync(terminal.showHistory(history));
      expect(screen()).toContain("Earlier message 29");
      expect(screen()).toContain("Ready");
      expect(screen()).not.toContain("Thinking");
      terminal.input("\u001b[5~");
      expect(screen()).not.toContain("Earlier message 29");
      expect(screen()).toContain("Earlier message 23");
      terminal.input("\u001b[6~");
      Effect.runSync(terminal.begin("New message"));
      Effect.runSync(terminal.answer("New answer"));
      expect(screen()).toContain("Earlier message 29");
      expect(screen()).toContain("New answer");
    } finally {
      terminal.close();
    }
  });

  test("renders saved and streamed assistant Markdown while keeping user input literal", () => {
    const { terminal, output, screen } = fixture(true);
    output.rows = 30;

    try {
      Effect.runSync(
        terminal.showHistory([
          { role: "user", text: "Keep **my input** literal" },
          { role: "assistant", text: "## Saved answer\n\nUse **this command**." },
        ]),
      );
      expect(screen()).toContain("**my input**");
      expect(screen()).toContain("Saved answer");
      expect(screen()).not.toContain("## Saved answer");
      expect(screen()).not.toContain("**this command**");
      Effect.runSync(terminal.begin("Continue"));
      terminal.input("**draft**");
      Effect.runSync(terminal.answer("```js\nconst value = 1;"));
      expect(screen()).toContain("const value = 1;");
      expect(screen()).not.toContain("```js");
      Effect.runSync(terminal.answer("\n```\n\n**Done.**"));
      expect(screen()).toContain("Done.");
      expect(screen()).not.toContain("**Done.**");
      expect(screen()).toContain("**draft**");
    } finally {
      terminal.close();
    }
  });

  test("wraps wide text, scrolls history, and retains input through resize", () => {
    const { terminal, output, screen, frame } = fixture();

    try {
      Effect.runSync(terminal.begin("A long conversation"));
      Effect.runSync(terminal.answer(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n")));
      terminal.input("界".repeat(30) + "👩‍💻");
      expect(screen()).toContain("Line 39");
      terminal.input("\u001b[5~");
      expect(screen()).not.toContain("Line 39");
      terminal.input("\u001b[6~");
      output.columns = 24;
      output.rows = 12;
      const lines = screen().split("\r\n");
      expect(lines).toHaveLength(12);
      expect(lines.every((line) => Bun.stringWidth(line) <= 23)).toBe(true);
      expect(screen()).toContain("👩‍💻");
      // oxlint-disable-next-line no-control-regex
      expect(frame()).not.toMatch(/\u001b\[[\d;]*m/);
      output.columns = 5;
      output.rows = 2;
      expect(screen()).toBe("Resi");
      output.columns = 80;
      output.rows = 24;
      expect(screen()).toContain("界".repeat(30) + "👩‍💻");
    } finally {
      terminal.close();
    }
  });

  test("keeps information neutral, marks errors, and rejects output control sequences", () => {
    const { terminal, screen, frame } = fixture(true);

    try {
      Effect.runSync(terminal.info("Attached notes.md"));
      terminal.input("/attach notes.md\r");
      Effect.runSync(terminal.answer("Safe\u001b[2J text\u001b]0;bad title\u0007"));
      expect(screen()).toContain("Safe text");
      expect(screen()).toContain("1 attached");
      expect(frame()).not.toContain("\u001b[31m");
      expect(frame()).not.toContain("\u001b[2J");
      expect(frame()).not.toContain("bad title");
      Effect.runSync(terminal.error("Request failed"));
      terminal.render();
      expect(frame()).toContain("\u001b[31mError");
    } finally {
      terminal.close();
    }
  });

  test("Ctrl-D only exits at an empty idle composer and Ctrl-C also exits during inference", async () => {
    const { terminal, exits } = fixture();

    try {
      terminal.input("draft\u0004");
      expect(exits()).toBe(0);
      const read = Effect.runPromise(terminal.read);
      terminal.input("\r\u0004");
      expect(await read).toEqual({ text: "draft", attachments: [] });
      expect(exits()).toBe(0);
      terminal.input("\u0003");
      expect(exits()).toBe(1);
    } finally {
      terminal.close();
    }
  });
});

test.each(["cancel", "exit", "eof", "empty"])(
  "a real terminal restores raw mode, listeners, and screen after %s",
  async (mode) => {
    let transcript = "";
    let submitted = false;
    let cancelled = false;
    const finished = Promise.withResolvers<void>();

    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import { Effect } from "effect";
    import { openChatTerminal } from "./terminal.ts";
    const before = process.stdin.listenerCount("data");
    let interrupted = false;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { terminal, stopped } = yield* openChatTerminal;
      const chat = Effect.gen(function* () {
        yield* terminal.welcome("/attach <path> adds a file to the next message.");
        if (${JSON.stringify(mode)} !== "empty") yield* terminal.session("saved-session");
        const text = yield* terminal.read;
        if (text === null) return;
        yield* terminal.begin(text.text);
        yield* terminal.answer("STREAMING");
        yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })));
      });
      yield* Effect.raceFirst(chat, stopped);
    })));
    console.log("RESULT " + JSON.stringify({ interrupted, raw: process.stdin.isRaw, listeners: process.stdin.listenerCount("data") - before }));
    `,
      ],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color", NO_COLOR: "1" },
        terminal: {
          cols: 60,
          rows: 20,
          data(terminal, data) {
            transcript += new TextDecoder().decode(data);

            if (!submitted && transcript.includes("/attach <path>")) {
              submitted = true;
              terminal.write(
                { exit: "/exit\r", eof: "\u0004", empty: "\u0004", cancel: "Hello\r" }[mode]!,
              );
            }

            if (!cancelled && transcript.includes("STREAMING")) {
              cancelled = true;
              terminal.resize(40, 12);
              terminal.write("queued message\rnext draft\u001b[99;5u");
            }
          },
          exit: () => finished.resolve(),
        },
      },
    );

    try {
      const [code] = await Effect.runPromise(
        Effect.promise(() => Promise.all([child.exited, finished.promise])).pipe(
          Effect.timeout("3 seconds"),
        ),
      );

      expect(code).toBe(0);
      expect(JSON.parse(transcript.match(/RESULT (.+)/)?.[1] ?? "null")).toEqual({
        interrupted: mode === "cancel",
        raw: false,
        listeners: 0,
      });
      expect(transcript).toContain("\u001b[>1u");
      expect(transcript).toContain("\u001b[<u");
      expect(transcript).toContain("\u001b[?2004l");
      expect(transcript).toContain("\u001b[?1049l");

      const [screen, scrollback] = transcript.split("\u001b[?1049l");
      expect(screen).toContain("/attach <path>");
      expect(scrollback).not.toContain("/attach <path>");

      expect(scrollback).not.toContain("STREAMING");
      expect(scrollback).not.toContain("Hello");
      expect(scrollback).not.toContain("queued message");

      if (mode === "empty") {
        expect(scrollback).toContain("No session was created.");
        expect(scrollback).not.toContain("poppet chat interactive");
      } else expect(scrollback).toContain("poppet chat interactive saved-session");
    } catch (error) {
      console.error(transcript);
      throw error;
    } finally {
      child.kill("SIGKILL");
      child.terminal?.close();
      await child.exited;
    }
  },
);
