import { describe, expect, jest, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { Effect } from "effect";

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
    "animates quiet thinking with colour=%j and stops on answers, errors, and exit",
    (color) => {
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
        expect(frame()).toBe(answered);
        expect(stripVTControlCharacters(frame())).toContain("Responding");
        Effect.runSync(terminal.begin("Again"));
        Effect.runSync(terminal.error("Unavailable"));
        jest.advanceTimersByTime(20);
        const failed = frame();
        jest.advanceTimersByTime(400);
        expect(frame()).toBe(failed);
        expect(stripVTControlCharacters(frame())).toContain("Request failed");
        Effect.runSync(terminal.begin("Last try"));
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

  test("streams answers while retaining an edited draft and blocks concurrent submission", async () => {
    const { terminal, screen } = fixture();

    try {
      const first = Effect.runPromise(terminal.read);
      terminal.input("Hello\r");
      expect(await first).toBe("Hello");
      Effect.runSync(terminal.begin("Hello"));
      terminal.input("next\u001b[D\u007fX");
      Effect.runSync(terminal.answer("First part"));
      terminal.input("\r");
      Effect.runSync(terminal.answer(" and second part"));
      expect(screen()).toContain("First part and second part");
      expect(screen()).toContain("neXt");

      const second = Effect.runPromise(terminal.read);
      terminal.input("\r");
      expect(await second).toBe("neXt");
    } finally {
      terminal.close();
    }
  });

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
        expect(await read).toBe("!first\nsecondend");
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
      expect(await read).toBe("first\nsecond\n/exit\nlast");

      const next = Effect.runPromise(terminal.read);
      terminal.input("draft\u001b[A");
      expect(screen()).toContain("second");
      terminal.input("\u001b[B\r");
      expect(await next).toBe("draft");
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
      Effect.runSync(terminal.setAttachments(["notes.md"]));
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
      expect(await read).toBe("draft");
      expect(exits()).toBe(0);
      terminal.input("\u0003");
      expect(exits()).toBe(1);
    } finally {
      terminal.close();
    }
  });
});

test.each(["cancel", "exit", "eof"])(
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
        const text = yield* terminal.read;
        if (text === "/exit") return;
        yield* terminal.begin(text);
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
              terminal.write({ exit: "/exit\r", eof: "\u0004", cancel: "Hello\r" }[mode]!);
            }

            if (!cancelled && transcript.includes("STREAMING")) {
              cancelled = true;
              terminal.resize(40, 12);
              terminal.write("next draft\u001b[99;5u");
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

      if (mode === "cancel") expect(scrollback).toContain("STREAMING");
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
