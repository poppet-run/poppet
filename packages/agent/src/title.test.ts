import { expect, test } from "bun:test";

import { sessionTitle } from "#src/title";

test("titles normalize controls and Unicode whitespace, with safe word and character limits", () => {
  expect(sessionTitle("\t Hello\n\u0000there\u2028\u200d 😀  ")).toBe("Hello there 😀");
  expect(sessionTitle("\u0000\u202e\t")).toBe("New conversation");
  expect(sessionTitle("a ".repeat(39) + "word-boundary")).toBe("a ".repeat(38) + "a");
  expect(sessionTitle("😀".repeat(90))).toBe("😀".repeat(80));
  expect(sessionTitle("a".repeat(80) + " word")).toBe("a".repeat(80));
  expect(sessionTitle("a".repeat(80))).toBe("a".repeat(80));
});
