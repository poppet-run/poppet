import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Effect, Layer } from "effect";

import { AgentError } from "#src/errors";
import { Skills, SkillsLive, skillDescription, skillIndex } from "#src/skills";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-skills-"));
  const root = join(directory, "skills");

  const layer = SkillsLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "test",
        model: null,
      }),
    ),
  );

  return {
    directory,
    root,
    load: (name: string) =>
      Effect.runPromise(Skills.use((skills) => skills.load(name)).pipe(Effect.provide(layer))),
    list: () => Effect.runPromise(Skills.use((skills) => skills.list).pipe(Effect.provide(layer))),
    save: async (name: string, content: string | Buffer) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "SKILL.md"), content);
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("local Markdown skills", () => {
  test("lists missing roots as empty without creating them and loads exact UTF-8 byte limits", async () => {
    const state = await fixture();

    try {
      expect(await state.list()).toEqual([]);
      await state.save("weekly-review", "😀".repeat(2048));
      await state.save("alpha", "# A procedure\nUse existing tools.");
      expect(await state.list()).toEqual(["alpha", "weekly-review"]);
      expect(await state.load("weekly-review")).toEqual({
        name: "weekly-review",
        content: "😀".repeat(2048),
      });
      await rm(state.root, { recursive: true });
      await rm(state.directory, { recursive: true });
      expect(await state.list()).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test.each(["../outside", "/tmp/outside", "a/b", ".", "..", "bad\0name", "", "x".repeat(129)])(
    "rejects skill paths and invalid names: %s",
    async (name) => {
      const state = await fixture();

      try {
        await expect(state.load(name)).rejects.toMatchObject({ reason: "invalid-request" });
      } finally {
        await state.close();
      }
    },
  );

  test.each(["x".repeat(8193), "😀".repeat(2049), Buffer.from([0xff]), "nul\0text"])(
    "rejects oversized or invalid UTF-8 content",
    async (content) => {
      const state = await fixture();

      try {
        await state.save("invalid", content);
        await expect(state.load("invalid")).rejects.toMatchObject({ reason: "invalid-request" });
      } finally {
        await state.close();
      }
    },
  );

  test.each(["root-link", "directory-link", "file-link", "hard-link", "directory-file", "missing"])(
    "rejects %s without using the target",
    async (kind) => {
      const state = await fixture();

      try {
        const outside = join(state.directory, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "SKILL.md"), "Outside procedure");
        await mkdir(state.root);

        if (kind === "root-link") {
          await rm(state.root, { recursive: true });
          await symlink(outside, state.root);
        } else if (kind === "directory-link") await symlink(outside, join(state.root, "review"));
        else {
          await mkdir(join(state.root, "review"));
          const target = join(state.root, "review", "SKILL.md");

          if (kind === "file-link") await symlink(join(outside, "SKILL.md"), target);

          if (kind === "hard-link") await link(join(outside, "SKILL.md"), target);

          if (kind === "directory-file") await mkdir(target);
        }

        await expect(state.load("review")).rejects.toMatchObject({ reason: "invalid-request" });

        if (kind === "root-link")
          await expect(state.list()).rejects.toMatchObject({ reason: "invalid-request" });
      } finally {
        await state.close();
      }
    },
  );
});

const service = (names: ReadonlyArray<string>): Skills["Service"] => ({
  list: Effect.succeed(names),
  load: (name) =>
    name.startsWith("bad")
      ? Effect.fail(new AgentError({ reason: "invalid-request", message: "invalid" }))
      : Effect.succeed({ name, content: `# ${name}\n\nDoes ${name} things.` }),
});

const index = (names: ReadonlyArray<string>, bytes: number) =>
  Effect.runPromise(skillIndex(service(names), bytes));

describe("skill index", () => {
  test.each([
    [
      "# Weekly review\n\nSummarize progress\nand next actions.\n\nMore.",
      "Weekly review: Summarize progress and next actions.",
    ],
    ["Plain first paragraph.", "Plain first paragraph."],
    ["## Only heading", "Only heading"],
    ["", ""],
  ])("describes %j", (content, description) => {
    expect(skillDescription(content)).toBe(description);
  });

  test("bounds long descriptions", () => {
    const description = skillDescription(`# Title\n\n${"word ".repeat(200)}`);
    expect(Buffer.byteLength(description)).toBeLessThanOrEqual(240);
    expect(description.endsWith("…")).toBe(true);
  });

  test("omits invalid skills and returns null when none remain", async () => {
    expect(await index(["alpha", "bad"], 8192)).toEqual({
      skills: [{ name: "alpha", description: "alpha: Does alpha things." }],
      truncated: false,
    });
    expect(await index(["bad"], 8192)).toBeNull();
    expect(await index([], 8192)).toBeNull();
  });

  test("falls back to names, then fewer names, within the budget", async () => {
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

  test("marks more than 64 skills as truncated", async () => {
    const names = Array.from({ length: 70 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const result = await index(names, 65536);
    expect(result?.skills).toHaveLength(64);
    expect(result?.truncated).toBe(true);
  });
});
