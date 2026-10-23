import { describe, expect, test } from "bun:test";

import { sessionTitle } from "#src/title";

describe("sessionTitle", () => {
  test("when titles contain controls or long Unicode text, normalizes whitespace and truncates safely", () => {
    expect(sessionTitle("\t Hello\n\u0000there\u2028\u200d 😀  ")).toBe("Hello there 😀");
    expect(sessionTitle("\u0000\u202e\t")).toBe("New conversation");
    expect(sessionTitle("😀".repeat(90))).toBe("😀".repeat(80));
  });
});
