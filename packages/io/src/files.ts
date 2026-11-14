import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Schema } from "effect";

export const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

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

export const unlinkIfPresent = (path: string): Promise<void> =>
  unlink(path).catch((cause: unknown) => {
    if (!isMissingFile(cause)) throw cause;
  });

export const openNoFollow = (path: string): Promise<FileHandle | null> =>
  open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (cause: unknown) => {
      if (isMissingFile(cause)) return null;
      throw cause;
    },
  );

export const readFileBounded = async (
  handle: {
    readonly read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ readonly bytesRead: number }>;
  },
  maxBytes: number,
  tooLarge: () => Error,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;

  while (length < buffer.length) {
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop -- Short reads must advance the offset before reading again.
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

    if (bytesRead === 0) break;
    length += bytesRead;
  }

  signal?.throwIfAborted();

  if (length > maxBytes) throw tooLarge();

  return buffer.subarray(0, length);
};

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

    const bytes =
      maxBytes === Infinity
        ? await handle.readFile()
        : await readFileBounded(handle, maxBytes, () => new Error("Protected file is too large"));

    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
};

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
