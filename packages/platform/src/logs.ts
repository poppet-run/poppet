import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { ensurePrivateDirectory, isMissingFile, openNoFollow } from "@poppet/io";

import { WorkerError } from "#src/contract";

export const regularFileInfo = async (path: string) => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

  if (info !== null && (!info.isFile() || info.isSymbolicLink()))
    throw new WorkerError({ message: `Expected a regular file at ${path}.` });

  return info;
};

export const prepareWorkerLog = async (directory: string, log: string) => {
  await ensurePrivateDirectory(directory).catch(() => {
    throw new WorkerError({ message: "The log directory must be a real directory." });
  });

  await regularFileInfo(log);

  const handle = await open(
    log,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
};

export const readWorkerLogs = async (log: string) => {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  let remaining = 65_536;
  let truncated = false;

  /* eslint-disable no-await-in-loop */
  for (const path of [log, `${log}.1`, `${log}.2`, `${log}.3`]) {
    if (remaining === 0) break;

    const handle = await openNoFollow(path);

    if (handle === null) continue;

    try {
      const info = await handle.stat();

      if (!info.isFile() || info.nlink !== 1)
        throw new WorkerError({ message: "Expected a regular worker log without links." });
      const identity = `${info.dev}:${info.ino}`;

      if (seen.has(identity)) continue;
      seen.add(identity);
      const start = Math.max(0, info.size - remaining);
      const buffer = Buffer.alloc(Math.min(info.size, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      chunks.unshift(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      truncated = start > 0;
    } finally {
      await handle.close();
    }
  }
  /* eslint-enable no-await-in-loop */

  const text = Buffer.concat(chunks).toString("utf8");

  return (truncated ? text.slice(text.indexOf("\n") + 1) : text).trimEnd() || "No worker logs yet.";
};
