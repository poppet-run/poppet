import { describe, expect, test } from "bun:test";

import { parseRelativeTime } from "#src/commands/tasks/tasks";

describe("relative task times", () => {
  test("when a duration crosses a daylight-saving transition, preserves elapsed time", () => {
    const now = Date.parse("2026-03-28T12:00:00Z");
    expect(parseRelativeTime("30s", now)).toBe(now + 30_000);
    expect(parseRelativeTime("10m", now)).toBe(now + 600_000);
    expect(parseRelativeTime("2h", now)).toBe(now + 7_200_000);
    expect(parseRelativeTime("1d", now)).toBe(Date.parse("2026-03-29T12:00:00Z"));
    expect(() => parseRelativeTime("1d", 8_640_000_000_000_000)).toThrow("too large");
  });
});
