import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFile, openNoFollow, readFileBounded } from "@poppet/io";

const fileInfo = (path: string) =>
  lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

/** Validate permissions without the chmod performed by normal credential readers. */
export const readCredentialFile = async (directory: string, name: string) => {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error("Invalid credential name");
  const parent = await fileInfo(join(directory, "auth"));

  if (parent === null) return null;

  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error("Unsafe authentication directory");
  const path = join(directory, "auth", name);
  const handle = await openNoFollow(path);

  if (handle === null) return null;

  try {
    const info = await handle.stat();

    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536
    )
      throw new Error("Unsafe credential file");
    const bytes = await readFileBounded(handle, 65536, () => new Error("Credential file limit"));

    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
};
