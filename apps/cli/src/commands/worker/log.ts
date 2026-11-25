import { closeSync, constants, fstatSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDirectorySync, isMissingFile, openProtectedFileSync } from "@poppet/io";

export const workerLogBytes = 5 * 1024 * 1024;

export const prepareWorkerLogDirectory = (directory: string) => {
  ensurePrivateDirectorySync(directory);
};

const openFile = (file: string, flags: number) =>
  openProtectedFileSync(file, flags, { makePrivate: true });

export const openWorkerLog = (directory: string) => {
  prepareWorkerLogDirectory(directory);
  const path = join(directory, "worker.log");
  const paths = [path, `${path}.1`, `${path}.2`, `${path}.3`];

  const validate = () => {
    for (const file of paths) {
      try {
        closeSync(openFile(file, constants.O_RDONLY));
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }
  };

  validate();
  let handle = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  let size = fstatSync(handle).size;

  const rotate = () => {
    if (handle === -1) {
      throw new Error("The worker log is closed.");
    }

    validate();
    const previous = handle;
    handle = -1;
    closeSync(previous);

    for (let index = paths.length - 1; index >= 0; index--) {
      const file = paths[index];

      if (file === undefined) {
        continue;
      }

      try {
        const next = paths[index + 1];

        if (next === undefined) {
          unlinkSync(file);
        } else {
          renameSync(file, next);
        }
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }

    handle = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    size = 0;
  };

  return {
    write: (chunk: Uint8Array) => {
      if (handle === -1) {
        throw new Error("The worker log is closed.");
      }

      let offset = 0;

      while (offset < chunk.length) {
        if (size >= workerLogBytes) {
          rotate();
        }

        const written = writeSync(
          handle,
          chunk,
          offset,
          Math.min(chunk.length - offset, workerLogBytes - size),
        );

        if (written === 0) {
          throw new Error("Could not write the worker log.");
        }

        offset += written;
        size += written;
      }
    },
    close: () => {
      const previous = handle;
      handle = -1;

      if (previous !== -1) {
        closeSync(previous);
      }
    },
  };
};
