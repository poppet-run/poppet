import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { Effect } from "effect";

test.each(["submit", "cancel", "correct"])(
  "API-key input masks pasted text and restores the terminal after %s",
  async (mode) => {
    let transcript = "";
    let submitted = false;
    let corrected = false;
    const finished = Promise.withResolvers<void>();

    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { Effect, Redacted } from "effect";
        import { readHiddenKey } from "./api-key-input.ts";
        const result = await Effect.runPromise(readHiddenKey("test-provider").pipe(
          Effect.map((key) => ({ saved: Redacted.value(key) === "fake-secret" })),
          Effect.catch((error) => Effect.succeed({ cancelled: error.message === "API-key login cancelled." })),
        ));
        console.log("RESULT " + JSON.stringify({ ...result, raw: process.stdin.isRaw }));
        `,
      ],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color", NO_COLOR: "1" },
        terminal: {
          cols: 80,
          rows: 24,
          data(terminal, data) {
            transcript += new TextDecoder().decode(data);

            if (!submitted && transcript.includes("input masked")) {
              submitted = true;
              terminal.write(
                mode === "correct"
                  ? "invalid secret\r"
                  : "discard\u0015fake-secretX\u007f" + (mode === "submit" ? "\r" : "\u0003"),
              );
            }

            if (
              mode === "correct" &&
              !corrected &&
              transcript.includes("Enter a nonempty API key")
            ) {
              corrected = true;
              terminal.write("\u0015fake-secret\r");
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
      expect(stripVTControlCharacters(transcript)).toContain("*******");
      expect(stripVTControlCharacters(transcript)).toContain("************");
      expect(transcript).not.toContain("discard");
      expect(transcript).not.toContain("invalid secret");
      expect(transcript).not.toContain("fake-secret");
      expect(JSON.parse(transcript.match(/RESULT (.+)/)?.[1] ?? "null")).toEqual({
        ...(mode === "cancel" ? { cancelled: true } : { saved: true }),
        raw: false,
      });
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
