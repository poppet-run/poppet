import { basename } from "node:path";

import { readProtectedFile } from "@poppet/io";

import { MemoryError } from "#src/service";

export const memoryLimit = (part: string, maximum: number) =>
  new MemoryError({
    reason: "limit",
    message: `The ${part} exceeds the ${maximum}-byte limit. Shorten it.`,
  });

export const readContextFile = async (path: string, maximum: number) =>
  (await readProtectedFile(path, {
    maxBytes: maximum,
    ownerWriteOnly: true,
    strictUtf8: true,
    disallowNul: true,
    onTooLarge: () => memoryLimit(basename(path), maximum),
  })) ?? "";
