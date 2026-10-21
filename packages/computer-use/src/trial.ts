import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { computerFailure } from "#src/errors";

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

export const requireStandaloneComputer = (workerSocket: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await lstat(workerSocket).catch((cause: unknown) => {
        if (missing(cause)) return null;
        throw cause;
      });

      if (info !== null) throw new Error("Worker endpoint exists");
    },
    catch: () =>
      computerFailure(
        "tool-permission",
        "Computer trials require standalone storage. Stop the worker or use a separate POPPET_DATA_DIR; this request was not routed through it.",
      ),
  });

export const validateComputerTrial = (state: {
  readonly dataDirectory: string;
  readonly notesDirectory: string;
  readonly otherCapabilities: boolean;
  readonly hasContext: boolean;
  readonly scheduledTasks: number;
}) =>
  Effect.gen(function* () {
    if (state.otherCapabilities || state.hasContext || state.scheduledTasks !== 0)
      return yield* Effect.fail(
        computerFailure(
          "tool-permission",
          "Use separate computer trial data with empty soul/profile/memory, no scheduled work, and browser, MCP, and search disabled.",
        ),
      );
    yield* Effect.tryPromise({
      try: async () => {
        for (const path of [state.notesDirectory, join(state.dataDirectory, "channels")]) {
          // Inspect only directory metadata; never load notes or channel credentials.
          // eslint-disable-next-line no-await-in-loop
          const info = await lstat(path).catch((cause: unknown) => {
            if (missing(cause)) return null;
            throw cause;
          });

          if (info === null) continue;

          // eslint-disable-next-line no-await-in-loop
          if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length !== 0)
            throw new Error("Trial data is not empty");
        }
      },
      catch: () =>
        computerFailure(
          "tool-permission",
          "Computer trials require empty notes and no configured channels. Use a separate POPPET_DATA_DIR.",
        ),
    });
  });
