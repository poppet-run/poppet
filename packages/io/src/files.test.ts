import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensurePrivateDirectory,
  isMissingFile,
  readFileBounded,
  readProtectedFile,
  writeFileAtomic,
} from "#src/files";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "poppet-io-files-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("files.ts", () => {
  test("when filesystem reads are short, reads the complete file through the exact byte limit", async () => {
    const path = join(directory, "short-reads.txt");
    const text = "a🙂z";
    await writeFile(path, text);
    const handle = await open(path, "r");

    try {
      const bytes = await readFileBounded(
        {
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, Math.min(length, 2), position),
        },
        Buffer.byteLength(text),
        () => new Error("Too large"),
      );

      expect(bytes.toString("utf8")).toBe(text);
    } finally {
      await handle.close();
    }
  });

  test("when a file grows after stat, consumes only one byte beyond the limit before rejecting it", async () => {
    const path = join(directory, "growing.txt");
    await writeFile(path, "ok");
    const handle = await open(path, "r");

    try {
      const { size } = await handle.stat();
      await appendFile(path, "x".repeat(1024));
      let consumed = 0;
      const failure = new Error("Too large");

      await expect(
        readFileBounded(
          {
            read: async (buffer, offset, length, position) => {
              const result = await handle.read(buffer, offset, length, position);
              consumed += result.bytesRead;

              return result;
            },
          },
          size,
          () => failure,
        ),
      ).rejects.toBe(failure);
      expect(consumed).toBe(size + 1);
    } finally {
      await handle.close();
    }
  });

  test("when cancelled during a short read, stops before requesting more bytes", async () => {
    const path = join(directory, "cancelled.txt");
    await writeFile(path, "unfinished");
    const handle = await open(path, "r");
    const controller = new AbortController();
    const failure = new Error("Cancelled");
    let reads = 0;

    try {
      await expect(
        readFileBounded(
          {
            read: async (buffer, offset, length, position) => {
              reads++;
              const result = await handle.read(buffer, offset, Math.min(length, 2), position);
              controller.abort(failure);

              return result;
            },
          },
          100,
          () => new Error("Too large"),
          controller.signal,
        ),
      ).rejects.toBe(failure);
      expect(reads).toBe(1);
    } finally {
      await handle.close();
    }
  });

  test("when a private directory is missing, creates it only if asked", async () => {
    const path = join(directory, "auth");

    expect(await ensurePrivateDirectory(path, { create: false })).toBe(false);
    expect(await ensurePrivateDirectory(path)).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
  });

  test("when a private directory is widened or replaced by a symlink, narrows or rejects it", async () => {
    const path = join(directory, "auth");
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);

    expect(await ensurePrivateDirectory(path, { create: false })).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o700);

    const linked = join(directory, "linked");
    await symlink(path, linked);
    await expect(ensurePrivateDirectory(linked)).rejects.toThrow();
  });

  test("when the file is missing, returns null", async () => {
    expect(await readProtectedFile(join(directory, "missing.json"))).toBeNull();
    expect(isMissingFile(Object.assign(new Error("Missing"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingFile(Object.assign(new Error("Denied"), { code: "EACCES" }))).toBe(false);
  });

  test("when the file is owned and private, reads it and optionally narrows its mode", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "{}", { mode: 0o644 });

    expect(await readProtectedFile(path, { maxBytes: 2, ownerWriteOnly: true })).toBe("{}");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(await readProtectedFile(path, { makePrivate: true })).toBe("{}");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("when the path is a symlink, rejects it", async () => {
    const target = join(directory, "target.json");
    const path = join(directory, "settings.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path);

    await expect(readProtectedFile(path)).rejects.toThrow();
  });

  test("when the file has another hard link, rejects it", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await link(path, join(directory, "other.json"));

    await expect(readProtectedFile(path)).rejects.toThrow();
  });

  test("when the file exceeds its limit, rejects it", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "{} ", { mode: 0o600 });

    await expect(readProtectedFile(path, { maxBytes: 2 })).rejects.toThrow();
  });

  test("when group or other can write and owner-only write is required, rejects it", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "{}");
    await chmod(path, 0o620);

    await expect(readProtectedFile(path, { ownerWriteOnly: true })).rejects.toThrow();
    expect(await readProtectedFile(path)).toBe("{}");
  });

  test("when writing atomically, replaces the file privately and leaves no temporary file", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "old", { mode: 0o644 });

    await writeFileAtomic(path, "new");

    expect(await readProtectedFile(path)).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });

  test("when the rename fails, removes the temporary file", async () => {
    const path = join(directory, "settings");
    await mkdir(join(path, "child"), { recursive: true });

    await expect(writeFileAtomic(path, "new")).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["settings"]);
  });
});
