import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { AgentError } from "#src/errors";
import { skillDescription, skillIndex } from "#src/skill-index";
import type { Skills } from "#src/skills";

const service = (names: ReadonlyArray<string>): Skills["Service"] => ({
  list: Effect.succeed(names),
  load: (name) =>
    name.startsWith("bad")
      ? Effect.fail(new AgentError({ reason: "invalid-request", message: "invalid" }))
      : Effect.succeed({ name, content: `# ${name}\n\nDoes ${name} things.` }),
});

const index = (names: ReadonlyArray<string>, bytes: number) =>
  Effect.runPromise(skillIndex(service(names), bytes));

describe("skill-index.ts", () => {
  test.each([
    [
      "# Weekly review\n\nSummarize progress\nand next actions.\n\nMore.",
      "Weekly review: Summarize progress and next actions.",
    ],
    ["Plain first paragraph.", "Plain first paragraph."],
    ["## Only heading", "Only heading"],
    ["", ""],
  ])(
    "when skill content is %j, extracts its heading and first paragraph",
    (content, description) => {
      expect(skillDescription(content)).toBe(description);
    },
  );

  test("when a description exceeds 240 bytes, truncates it with an ellipsis", () => {
    const description = skillDescription(`# Title\n\n${"word ".repeat(200)}`);
    expect(Buffer.byteLength(description)).toBeLessThanOrEqual(240);
    expect(description.endsWith("…")).toBe(true);
  });

  test("when skills are invalid or absent, omits them and returns null if none remain", async () => {
    expect(await index(["alpha", "bad"], 8192)).toEqual({
      skills: [{ name: "alpha", description: "alpha: Does alpha things." }],
      truncated: false,
    });
    expect(await index(["bad"], 8192)).toBeNull();
    expect(await index([], 8192)).toBeNull();
  });

  test("when descriptions exceed the index budget, falls back to names and then fewer names", async () => {
    const names = ["alpha", "beta", "gamma"];
    expect(await index(names, 80)).toEqual({
      skills: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      truncated: true,
    });
    expect(await index(names, 50)).toEqual({
      skills: [{ name: "alpha" }],
      truncated: true,
    });
    expect(await index(names, 10)).toBeNull();
  });

  test("when more than 64 skills exist, limits the index and marks it truncated", async () => {
    const names = Array.from({ length: 70 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const result = await index(names, 65536);
    expect(result?.skills).toHaveLength(64);
    expect(result?.truncated).toBe(true);
  });
});
