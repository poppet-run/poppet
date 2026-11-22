import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Effect } from "effect";

import { openWorkerLog, prepareWorkerLogDirectory } from "#src/commands/worker/log";

export const runLoggedWorker = async (command: ReadonlyArray<string>, dataDirectory: string) => {
  const directory = join(dataDirectory, "logs");
  prepareWorkerLogDirectory(directory);

  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireOwnerLock(join(directory, "worker.lock"));

        return yield* Effect.promise(async () => {
          let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
          let pendingSignal: "SIGINT" | "SIGTERM" | null = null;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const stop = (signal: "SIGINT" | "SIGTERM") => {
            if (child === null) {
              pendingSignal ??= signal;

              return;
            }

            child.kill(signal);
            timer ??= setTimeout(() => child?.kill("SIGKILL"), 25_000);
          };

          const interrupt = () => stop("SIGINT");
          const terminate = () => stop("SIGTERM");
          process.on("SIGINT", interrupt);
          process.on("SIGTERM", terminate);

          let log: ReturnType<typeof openWorkerLog> | null = null;

          try {
            log = openWorkerLog(directory);
            const activeLog = log;

            if (pendingSignal !== null) return pendingSignal === "SIGINT" ? 130 : 143;

            child = Bun.spawn([...command], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });

            let writeError: unknown;
            let failed = false;

            const copy = async (stream: ReadableStream<Uint8Array>) => {
              const reader = stream.getReader();

              try {
                for (;;) {
                  // eslint-disable-next-line no-await-in-loop -- Stream chunks must be drained sequentially.
                  const { done, value } = await reader.read();

                  if (done) break;

                  if (!failed) {
                    try {
                      activeLog.write(value);
                    } catch (error) {
                      failed = true;
                      writeError ??= error;
                      stop("SIGTERM");
                    }
                  }
                }
              } finally {
                reader.releaseLock();
              }
            };

            const copies = [copy(child.stdout), copy(child.stderr)];

            try {
              const [exitCode] = await Promise.all([child.exited, Promise.all(copies)]);

              if (failed) throw writeError;

              return exitCode;
            } catch (error) {
              stop("SIGTERM");
              await child.exited;
              await Promise.allSettled(copies);
              throw error;
            }
          } finally {
            clearTimeout(timer);
            process.off("SIGINT", interrupt);
            process.off("SIGTERM", terminate);
            log?.close();
          }
        });
      }),
    ),
  );
};

if (import.meta.main) {
  try {
    const directory = process.env.POPPET_DATA_DIR;

    if (!directory) throw new Error("The background worker requires POPPET_DATA_DIR.");
    process.exitCode = await runLoggedWorker(
      [
        process.execPath,
        fileURLToPath(new URL("./main.ts", import.meta.url)),
        ...Bun.argv.slice(2),
      ],
      directory,
    );
  } catch {
    console.error(
      "Could not run the background worker. Check worker log permissions and ownership.",
    );
    process.exitCode = 1;
  }
}
