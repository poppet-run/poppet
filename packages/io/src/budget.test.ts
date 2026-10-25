import { describe, expect, test } from "bun:test";

import { clip, fitPrefix, fitText } from "#src/budget";

describe("clip", () => {
  test("when a multibyte character crosses the budget, stops before it", () => {
    expect(clip("ab😀c", 5)).toBe("ab");
    expect(clip("ab😀c", 6)).toBe("ab😀");
    expect(clip("abc", 16)).toBe("abc");
  });
});

describe("fitPrefix", () => {
  test("when the cut falls inside a surrogate pair, keeps the longest well-formed prefix", () => {
    const prefix = fitPrefix("😀".repeat(100), (candidate) => candidate.length <= 7);

    expect(prefix).toBe("😀".repeat(3));
  });

  test("when even an empty prefix does not fit, returns null", () => {
    expect(fitPrefix("text", () => false)).toBeNull();
  });
});

const render = (text: string, truncated: boolean) => JSON.stringify({ text, truncated });

describe("fitText", () => {
  test("when the whole text fits, renders it untruncated", () => {
    expect(fitText("short", 64, render)).toBe(render("short", false));
  });

  test("when the text is too long, keeps as many bytes as the budget allows", () => {
    const output = fitText('😀"'.repeat(4000), 1024, render)!;
    const result = JSON.parse(output);

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(output)).toBeGreaterThan(1024 - 8);
    expect(result.truncated).toBe(true);
    expect(result.text.isWellFormed()).toBe(true);
  });

  test("when the surrounding output alone exceeds the budget, returns null", () => {
    expect(fitText("text", 8, render)).toBeNull();
  });
});
