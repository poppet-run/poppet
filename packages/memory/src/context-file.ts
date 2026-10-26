import { basename } from "node:path";

import { openNoFollow, readFileBounded } from "@poppet/io";

import { MemoryError } from "#src/service";

export const memoryLimit = (part: string, maximum: number) =>
  new MemoryError({
    reason: "limit",
    message: `The ${part} exceeds the ${maximum}-byte limit. Shorten it.`,
  });

export const readContextFile = async (path: string, maximum: number) => {
  const file = await openNoFollow(path);

  if (file === null) return "";

  try {
    const metadata = await file.stat();

    if (!metadata.isFile()) throw new Error("Context must be a regular file.");

    if (metadata.size > maximum) throw memoryLimit(basename(path), maximum);
    const bytes = await readFileBounded(file, maximum, () => memoryLimit(basename(path), maximum));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    if (text.includes("\0")) throw new Error("Context must be UTF-8 text.");

    return text;
  } finally {
    await file.close();
  }
};
