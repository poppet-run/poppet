import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

export const workerLogBytes = 5 * 1024 * 1024;

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

export const prepareWorkerLogDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("The worker log directory must be a protected real directory.");
};

const openFile = (file: string, flags: number) => {
  const handle = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);

  try {
    const stat = fstatSync(handle);

    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
      throw new Error("Worker logs must be owned regular files without links.");
    fchmodSync(handle, 0o600);

    return handle;
  } catch (error) {
    closeSync(handle);
    throw error;
  }
};

/** One background launcher owns this writer and rotates only between completed writes. */
export const openWorkerLog = (directory: string) => {
  prepareWorkerLogDirectory(directory);
  const path = join(directory, "worker.log");
  const paths = [path, `${path}.1`, `${path}.2`, `${path}.3`];

  const validate = () => {
    for (const file of paths) {
      try {
        closeSync(openFile(file, constants.O_RDONLY));
      } catch (error) {
        if (!Schema.is(MissingFile)(error)) throw error;
      }
    }
  };

  validate();
  let handle = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  let size = fstatSync(handle).size;

  const rotate = () => {
    validate();
    closeSync(handle);
    handle = -1;

    for (let index = paths.length - 1; index >= 0; index--) {
      const file = paths[index]!;

      try {
        if (index === paths.length - 1) unlinkSync(file);
        else renameSync(file, paths[index + 1]!);
      } catch (error) {
        if (!Schema.is(MissingFile)(error)) throw error;
      }
    }

    handle = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    size = 0;
  };

  return {
    write: (chunk: Uint8Array) => {
      let offset = 0;

      while (offset < chunk.length) {
        if (size >= workerLogBytes) rotate();

        const written = writeSync(
          handle,
          chunk,
          offset,
          Math.min(chunk.length - offset, workerLogBytes - size),
        );

        if (written === 0) throw new Error("Could not write the worker log.");
        offset += written;
        size += written;
      }
    },
    close: () => {
      if (handle !== -1) closeSync(handle);
      handle = -1;
    },
  };
};
