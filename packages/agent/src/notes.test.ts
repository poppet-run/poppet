import { describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Effect, Layer } from "effect";

import { byteSize } from "#src/context";
import { Notes, NotesLive, type NoteCall } from "#src/notes";
import { ChatSettings, defaultPolicy } from "#src/settings";

const fixture = async (toolBytes = defaultPolicy.toolBytes) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-note-boundary-"));
  const notesDirectory = join(directory, "notes");

  const layer = NotesLive.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(AppConfig, {
          applicationName: "Test",
          dataDirectory: directory,
          notesDirectory,
          provider: "test-provider",
          model: "test-model",
        }),
        Layer.succeed(ChatSettings, { ...defaultPolicy, toolBytes }),
      ),
    ),
  );

  return {
    directory,
    notesDirectory,
    execute: (call: NoteCall) =>
      Effect.runPromise(Notes.use((notes) => notes.execute(call)).pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe("note filesystem boundary", () => {
  test("creates and atomically replaces notes in checked subdirectories, with relative and absolute reads", async () => {
    const state = await fixture();

    try {
      const saved = await state.execute({
        name: "save_note",
        path: "projects/acorn.md",
        content: "First version",
      });

      expect(JSON.parse(saved)).toMatchObject({ path: "projects/acorn.md", saved: true });
      await state.execute({ name: "save_note", path: "projects/acorn.md", content: "Replacement" });
      const path = join(await realpath(state.notesDirectory), "projects/acorn.md");
      expect(JSON.parse(await state.execute({ name: "read_note", path }))).toMatchObject({
        content: "Replacement",
        truncated: false,
      });
      expect(await readdir(join(state.notesDirectory, "projects"))).toEqual(["acorn.md"]);
      expect(await readFile(path, "utf8")).toBe("Replacement");
    } finally {
      await state.close();
    }
  });

  test.each([
    "relative escape",
    "absolute escape",
    "file symlink",
    "directory symlink",
    "hard link",
  ])("rejects %s without reading or replacing outside data", async (kind) => {
    const state = await fixture();

    try {
      await mkdir(state.notesDirectory);
      const outside = join(state.directory, "outside.md");
      await writeFile(outside, "Keep outside data");
      let path = "../outside.md";

      if (kind === "absolute escape") path = outside;

      if (kind === "file symlink") {
        path = "linked.md";
        await symlink(outside, join(state.notesDirectory, path));
      }

      if (kind === "directory symlink") {
        path = "linked/outside.md";
        await symlink(state.directory, join(state.notesDirectory, "linked"));
      }

      if (kind === "hard link") {
        path = "linked.md";
        await link(outside, join(state.notesDirectory, path));
      }

      await expect(state.execute({ name: "read_note", path })).rejects.toMatchObject({
        reason: "tool-permission",
      });
      await expect(
        state.execute({ name: "save_note", path, content: "Overwrite" }),
      ).rejects.toMatchObject({ reason: "tool-permission" });
      expect(await readFile(outside, "utf8")).toBe("Keep outside data");
    } finally {
      await state.close();
    }
  });

  test("rejects a symlink used as the configured root", async () => {
    const state = await fixture();

    try {
      const outside = join(state.directory, "outside");
      await mkdir(outside);
      await symlink(outside, state.notesDirectory);
      await expect(
        state.execute({ name: "save_note", path: "new.md", content: "No" }),
      ).rejects.toMatchObject({ reason: "tool-permission" });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test("caps UTF-8 read/search results and explicitly reports truncation without following search symlinks", async () => {
    const state = await fixture(1024);

    try {
      await mkdir(state.notesDirectory);
      const content = 'Acorn 😀\\"\n'.repeat(1000);
      await writeFile(join(state.notesDirectory, "large.md"), content);
      await writeFile(join(state.directory, "outside.md"), "PRIVATE OUTSIDE");
      await symlink(join(state.directory, "outside.md"), join(state.notesDirectory, "external.md"));
      const read = await state.execute({ name: "read_note", path: "large.md" });
      expect(byteSize(read)).toBeLessThanOrEqual(1024);
      expect(JSON.parse(read)).toMatchObject({ truncated: true });
      expect(content.startsWith(JSON.parse(read).content)).toBe(true);
      const search = await state.execute({ name: "search_notes", query: "Acorn" });
      expect(byteSize(search)).toBeLessThanOrEqual(1024);
      expect(JSON.parse(search)).toMatchObject({
        truncated: true,
        matches: expect.arrayContaining([expect.objectContaining({ path: "large.md", line: 1 })]),
      });
      expect(
        JSON.parse(await state.execute({ name: "search_notes", query: "PRIVATE" })).matches,
      ).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test("rejects oversized writes before touching existing content and reports missing/non-note targets", async () => {
    const state = await fixture();

    try {
      await mkdir(state.notesDirectory);
      await writeFile(join(state.notesDirectory, "existing.md"), "Original");
      await expect(
        state.execute({ name: "save_note", path: "existing.md", content: "😀".repeat(20000) }),
      ).rejects.toMatchObject({ reason: "tool-limit" });
      expect(await readFile(join(state.notesDirectory, "existing.md"), "utf8")).toBe("Original");
      await expect(state.execute({ name: "read_note", path: "missing.md" })).rejects.toMatchObject({
        reason: "tool-storage",
      });
      await expect(
        state.execute({ name: "save_note", path: "script.sh", content: "No" }),
      ).rejects.toMatchObject({ reason: "tool-permission" });
      await expect(state.execute({ name: "read_note", path: "nul\0.md" })).rejects.toMatchObject({
        reason: "tool-permission",
      });
    } finally {
      await state.close();
    }
  });
});
