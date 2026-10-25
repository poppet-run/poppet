import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Schema } from "effect";

export const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

/**
 * Makes a directory private to this user: creates it unless `create` is false, rejects anything
 * but a real directory this user owns, and narrows it to 0o700. False when missing and not created.
 */
export const ensurePrivateDirectory = async (
  path: string,
  options: { readonly create?: boolean } = {},
): Promise<boolean> => {
  if (options.create ?? true) await mkdir(path, { recursive: true, mode: 0o700 });

  const info = await lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

  if (info === null) return false;

  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("Invalid private directory");
  await chmod(path, 0o700);

  return true;
};

/** Removes a file; a missing file is already removed. */
export const unlinkIfPresent = (path: string): Promise<void> =>
  unlink(path).catch((cause: unknown) => {
    if (!isMissingFile(cause)) throw cause;
  });

/** Opens for reading without following a final symlink or blocking on a FIFO; null when missing. */
export const openNoFollow = (path: string): Promise<FileHandle | null> =>
  open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (cause: unknown) => {
      if (isMissingFile(cause)) return null;
      throw cause;
    },
  );

/**
 * Reads a regular file owned by this user with exactly one link; null when missing.
 * Optionally bounds its size, rejects group/other write access, or narrows it to 0o600.
 */
export const readProtectedFile = async (
  path: string,
  options: {
    readonly maxBytes?: number;
    readonly ownerWriteOnly?: boolean;
    readonly makePrivate?: boolean;
  } = {},
): Promise<string | null> => {
  const { maxBytes = Infinity, ownerWriteOnly = false, makePrivate = false } = options;
  const handle = await openNoFollow(path);

  if (handle === null) return null;

  try {
    const info = await handle.stat();

    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (ownerWriteOnly && (info.mode & 0o022) !== 0) ||
      info.size > maxBytes
    )
      throw new Error("Invalid protected file");

    if (makePrivate) await handle.chmod(0o600);
    const bytes = await handle.readFile();

    // The file can grow between stat and read.
    if (bytes.byteLength > maxBytes) throw new Error("Protected file is too large");

    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
};

/** Writes and syncs a private sibling file, then renames it over the target so readers never see partial contents. */
export const writeFileAtomic = async (path: string, contents: string): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
};
