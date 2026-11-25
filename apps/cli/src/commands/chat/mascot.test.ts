import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import {
  launchMascotExpressions,
  mascotWidth,
  pickMascotExpression,
  renderMascot,
} from "#src/commands/chat/mascot";
import type { MascotExpression } from "#src/commands/chat/mascot";

const allExpressions: ReadonlyArray<MascotExpression> = [...launchMascotExpressions, "oops"];

describe("pickMascotExpression", () => {
  test("when picking across the random range, covers every launch expression and excludes oops", () => {
    const picked = launchMascotExpressions.map((_, index) =>
      pickMascotExpression(() => (index + 0.5) / launchMascotExpressions.length),
    );

    expect(picked).toEqual([...launchMascotExpressions]);
    expect(picked).not.toContain("oops");
    expect(pickMascotExpression(() => 1)).toBe("focused");
    expect(pickMascotExpression(() => -0.5)).toBe("friendly");
  });
});

describe("renderMascot", () => {
  test.each(["truecolor", "256"] as const)(
    "when rendered in %s mode, produces distinct 8-row banners of fixed width for each expression",
    (colorMode) => {
      const rendered = new Set<string>();
      const sequencePrefix = colorMode === "truecolor" ? "\u001b[38;2;" : "\u001b[38;5;";

      for (const expression of allExpressions) {
        const lines = renderMascot(expression, colorMode);
        expect(lines).toHaveLength(8);
        expect(
          lines.every((line) => Bun.stringWidth(stripVTControlCharacters(line)) === mascotWidth),
        ).toBe(true);
        expect(lines.some((line) => line.includes(sequencePrefix))).toBe(true);
        rendered.add(lines.join("\n"));
      }

      expect(rendered.size).toBe(allExpressions.length);
    },
  );
});
