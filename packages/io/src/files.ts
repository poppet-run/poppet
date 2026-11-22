import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Schema } from "effect";

export const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const isOwnedPrivateDirectory = (info: Stats, strict: boolean) =>
  info.isDirectory() &&
  !info.isSymbolicLink() &&
  info.uid === process.getuid?.() &&
  (!strict || (info.mode & 0o077) === 0);

const isOwnedProtectedFile = (
  info: Stats,
  options: { readonly ownerWriteOnly?: boolean; readonly privateOnly?: boolean },
) =>
  info.isFile() &&
  info.nlink === 1 &&
  info.uid === process.getuid?.() &&
  (!options.ownerWriteOnly || (info.mode & 0o022) === 0) &&
  (!options.privateOnly || (info.mode & 0o077) === 0);

export const ensurePrivateDirectory = async (
  path: string,
  options: { readonly create?: boolean; readonly strict?: boolean } = {},
): Promise<boolean> => {
  if (options.create ?? true) await mkdir(path, { recursive: true, mode: 0o700 });

  const info = await lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

  if (info === null) return false;

  if (!isOwnedPrivateDirectory(info, options.strict === true))
    throw new Error("Expected a private directory owned by the current user.");

  if (options.strict !== true) await chmod(path, 0o700);

  return true;
};

export const ensurePrivateDirectorySync = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);

  if (!isOwnedPrivateDirectory(info, true))
    throw new Error("Expected a private directory owned by the current user.");
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

export const openProtectedFile = async (
  path: string,
  flags: number,
  options: {
    readonly ownerWriteOnly?: boolean;
    readonly privateOnly?: boolean;
    readonly makePrivate?: boolean;
  } = {},
): Promise<FileHandle> => {
  const handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);

  try {
    const info = await handle.stat();

    if (!isOwnedProtectedFile(info, options))
      throw new Error("Expected a private regular file owned by the current user.");

    if (options.makePrivate) await handle.chmod(0o600);

    return handle;
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
};

export const openProtectedFileSync = (
  path: string,
  flags: number,
  options: {
    readonly ownerWriteOnly?: boolean;
    readonly privateOnly?: boolean;
    readonly makePrivate?: boolean;
  } = {},
): number => {
  const handle = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);

  try {
    const info = fstatSync(handle);

    if (!isOwnedProtectedFile(info, options))
      throw new Error("Expected a private regular file owned by the current user.");

    if (options.makePrivate) fchmodSync(handle, 0o600);

    return handle;
  } catch (cause) {
    closeSync(handle);
    throw cause;
  }
};

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
    readonly privateOnly?: boolean;
    readonly makePrivate?: boolean;
    readonly strictUtf8?: boolean;
    readonly disallowNul?: boolean;
    readonly onTooLarge?: () => Error;
  } = {},
): Promise<string | null> => {
  const {
    maxBytes = Infinity,
    ownerWriteOnly = false,
    privateOnly = false,
    makePrivate = false,
    strictUtf8 = false,
    disallowNul = false,
    onTooLarge = () => new Error("Protected file is too large"),
  } = options;

  const handle = await openNoFollow(path);

  if (handle === null) return null;

  try {
    const info = await handle.stat();

    if (!isOwnedProtectedFile(info, { ownerWriteOnly, privateOnly }))
      throw new Error("Expected a private regular file owned by the current user.");

    if (info.size > maxBytes) throw onTooLarge();

    if (makePrivate) await handle.chmod(0o600);

    const bytes =
      maxBytes === Infinity
        ? await handle.readFile()
        : await readFileBounded(handle, maxBytes, onTooLarge);

    const text = strictUtf8
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes.toString("utf8");

    if (disallowNul && text.includes("\0")) throw new Error("Protected file must be UTF-8 text.");

    return text;
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
