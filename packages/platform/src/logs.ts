import { constants } from "node:fs";
import { lstat } from "node:fs/promises";

import { ensurePrivateDirectory, isMissingFile, openNoFollow, openProtectedFile } from "@poppet/io";

import { WorkerError } from "#src/contract";

export const regularFileInfo = async (path: string) => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) {
      return null;
    }

    throw cause;
  });

  if (info !== null && (!info.isFile() || info.isSymbolicLink())) {
    throw new WorkerError({ message: `Expected a regular file at ${path}.` });
  }

  return info;
};

export const prepareWorkerLog = async (directory: string, log: string) => {
  await ensurePrivateDirectory(directory).catch(() => {
    throw new WorkerError({ message: "The log directory must be a real directory." });
  });

  await regularFileInfo(log);

  const handle = await openProtectedFile(
    log,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    { makePrivate: true },
  ).catch(() => {
    throw new WorkerError({ message: "Expected a private regular worker log owned by you." });
  });

  await handle.close();
};

export const readWorkerLogs = async (log: string) => {
  const chunks: Array<Buffer> = [];
  const seen = new Set<string>();
  let remaining = 65_536;
  let truncated = false;

  for (const path of [log, `${log}.1`, `${log}.2`, `${log}.3`]) {
    const handle = await openNoFollow(path);

    if (handle === null) {
      continue;
    }

    try {
      const info = await handle.stat();

      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) {
        throw new WorkerError({
          message: "Expected a regular worker log owned by you without links.",
        });
      }

      const identity = `${info.dev}:${info.ino}`;

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);

      if (remaining === 0) {
        if (info.size === 0) {
          continue;
        }

        truncated = true;
        break;
      }

      const start = Math.max(0, info.size - remaining);
      const target = Math.min(info.size, remaining);
      const buffer = Buffer.alloc(target);
      let read = 0;

      while (read < target) {
        const { bytesRead } = await handle.read(buffer, read, target - read, start + read);

        if (bytesRead === 0) {
          break;
        }

        read += bytesRead;
      }

      chunks.unshift(buffer.subarray(0, read));
      remaining -= read;
      truncated ||= start > 0;
    } finally {
      await handle.close();
    }
  }

  const text = Buffer.concat(chunks).toString("utf8");

  return (truncated ? text.slice(text.indexOf("\n") + 1) : text).trimEnd() || "No worker logs yet.";
};
