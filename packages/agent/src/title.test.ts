import { expect, test } from "bun:test";

import { sessionTitle } from "#src/title";

test("titles normalize controls and Unicode whitespace, with a Unicode-safe character limit", () => {
  expect(sessionTitle("\t Hello\n\u0000there\u2028\u200d 😀  ")).toBe("Hello there 😀");
  expect(sessionTitle("\u0000\u202e\t")).toBe("New conversation");
  expect(sessionTitle("😀".repeat(90))).toBe("😀".repeat(80));
});
