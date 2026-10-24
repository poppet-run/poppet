import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isMissingFile, readProtectedFile, writeFileAtomic } from "#src/files";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "poppet-io-files-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("files.ts", () => {
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
