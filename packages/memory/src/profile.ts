/* eslint-disable no-await-in-loop -- A bounded profile read must handle short filesystem reads sequentially. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { Schema } from "effect";

import { MemoryError } from "#src/service";

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

export const memoryLimit = (part: string, setting: string) =>
  new MemoryError({
    reason: "limit",
    message: `The ${part} exceeds ${setting}. Shorten it or increase the budget.`,
  });

export const readProfile = async (path: string, maximum: number) => {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });

  if (file === null) return "";

  try {
    const metadata = await file.stat();

    if (!metadata.isFile()) throw new Error("Profile must be a regular file.");

    if (metadata.size > maximum) throw memoryLimit("profile", "POPPET_PROFILE_BYTES");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;

    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);

      if (bytesRead === 0) break;
      length += bytesRead;
    }

    if (length > maximum) throw memoryLimit("profile", "POPPET_PROFILE_BYTES");
    const profile = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));

    if (profile.includes("\0")) throw new Error("Profile must be UTF-8 text.");

    return profile;
  } finally {
    await file.close();
  }
};
