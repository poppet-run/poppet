/* eslint-disable no-await-in-loop -- A bounded file read must handle short filesystem reads sequentially. */
import { basename } from "node:path";

import { openNoFollow } from "@poppet/io";

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
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;

    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);

      if (bytesRead === 0) break;
      length += bytesRead;
    }

    if (length > maximum) throw memoryLimit(basename(path), maximum);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));

    if (text.includes("\0")) throw new Error("Context must be UTF-8 text.");

    return text;
  } finally {
    await file.close();
  }
};
