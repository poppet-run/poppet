import { describe, expect, test } from "bun:test";

import { quietHoursEnd } from "#src/quiet-hours";

const london = "Europe/London";

describe("quietHoursEnd", () => {
  test.each([
    [
      "before midnight in a window crossing midnight",
      "22:00",
      "07:30",
      "2026-11-17T23:00:00Z",
      "2026-11-18T07:30:00Z",
    ],
    [
      "after midnight in a window crossing midnight",
      "22:00",
      "07:30",
      "2026-11-18T06:00:00Z",
      "2026-11-18T07:30:00Z",
    ],
    ["at the end of a window", "22:00", "07:30", "2026-11-18T07:30:00Z", null],
    ["between windows", "22:00", "07:30", "2026-11-18T12:00:00Z", null],
    ["inside a daytime window", "09:00", "17:00", "2026-11-17T10:00:00Z", "2026-11-17T17:00:00Z"],
    [
      "at 01:00 GMT when the 01:30 end is skipped",
      "22:00",
      "01:30",
      "2026-03-29T00:30:00Z",
      "2026-03-29T01:00:00Z",
    ],
    ["at 00:59 GMT before a skipped 01:30 start", "01:30", "06:00", "2026-03-29T00:59:00Z", null],
    [
      "at 02:00 BST after a skipped 01:30 start",
      "01:30",
      "06:00",
      "2026-03-29T01:00:00Z",
      "2026-03-29T05:00:00Z",
    ],
    [
      "at 01:15 BST before a repeated 01:30 end",
      "22:00",
      "01:30",
      "2026-10-25T00:15:00Z",
      "2026-10-25T00:30:00Z",
    ],
    [
      "at the repeated 01:15 GMT after the window ended",
      "22:00",
      "01:30",
      "2026-10-25T01:15:00Z",
      null,
    ],
    [
      "at the first 01:30 BST of a repeated start",
      "01:30",
      "06:00",
      "2026-10-25T00:30:00Z",
      "2026-10-25T06:00:00Z",
    ],
  ])("when %s (%s-%s) at %s, returns %s", (_, start, end, at, expected) => {
    expect(quietHoursEnd({ start, end, timeZone: london }, Date.parse(at))).toBe(
      expected === null ? null : Date.parse(expected),
    );
  });
});
