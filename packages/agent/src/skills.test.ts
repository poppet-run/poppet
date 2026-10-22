import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Effect, Layer } from "effect";

import { contextFiles } from "#src/context-files";
import { Skills, SkillsLive } from "#src/skills";

const fixture = async (withFallback = false) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-skills-"));
  const root = join(directory, "skills");

  const fallback = join(directory, ".agent");

  const layer = (
    withFallback ? Layer.effect(Skills, contextFiles("skills", "SKILL.md", fallback)) : SkillsLive
  ).pipe(
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
    fallbackRoot: join(fallback, "skills"),
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

  test("merges skill roots and prefers data-directory entries without hiding invalid files", async () => {
    const state = await fixture(true);

    try {
      expect(await state.list()).toEqual([]);
      await mkdir(join(state.fallbackRoot, "shared"), { recursive: true });
      await writeFile(join(state.fallbackRoot, "shared", "SKILL.md"), "Home procedure");
      expect(await state.list()).toEqual(["shared"]);
      expect(await state.load("shared")).toEqual({ name: "shared", content: "Home procedure" });
      await state.save("local", "Local procedure");
      await state.save("shared", "Local override");
      expect(await state.list()).toEqual(["local", "shared"]);
      expect((await state.load("shared")).content).toBe("Local override");
      await state.save("shared", "x".repeat(8193));
      await expect(state.load("shared")).rejects.toMatchObject({ reason: "invalid-request" });
      await rm(join(state.root, "shared", "SKILL.md"));
      await expect(state.load("shared")).rejects.toMatchObject({ reason: "invalid-request" });
      await rm(state.root, { recursive: true });
      await rm(join(state.fallbackRoot, "shared"), { recursive: true });
      await symlink(state.directory, join(state.fallbackRoot, "shared"));
      await expect(state.load("shared")).rejects.toMatchObject({ reason: "invalid-request" });
      await rm(state.fallbackRoot, { recursive: true });
      await symlink(state.directory, state.fallbackRoot);
      await expect(state.list()).rejects.toMatchObject({ reason: "invalid-request" });
      await expect(state.load("shared")).rejects.toMatchObject({ reason: "invalid-request" });
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
