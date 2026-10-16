import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Effect } from "effect";

import { openWorkerLog, prepareWorkerLogDirectory } from "#src/worker-log";

/** Keeps launchd's file descriptors out of the worker so rotated files can be closed. */
export const runLoggedWorker = async (command: ReadonlyArray<string>, dataDirectory: string) => {
  const directory = join(dataDirectory, "logs");
  prepareWorkerLogDirectory(directory);

  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireOwnerLock(join(directory, "worker.lock"));

        return yield* Effect.promise(async () => {
          const log = openWorkerLog(directory);

          try {
            const child = Bun.spawn([...command], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });

            let timer: ReturnType<typeof setTimeout> | undefined;

            const stop = (signal: "SIGINT" | "SIGTERM") => {
              child.kill(signal);
              // Leave launchd's 30-second exit window room to drain and close the log.
              timer ??= setTimeout(() => child.kill("SIGKILL"), 25_000);
            };

            const interrupt = () => stop("SIGINT");
            const terminate = () => stop("SIGTERM");
            process.on("SIGINT", interrupt);
            process.on("SIGTERM", terminate);

            const copy = async (stream: ReadableStream<Uint8Array>) => {
              for await (const chunk of stream) log.write(chunk);
            };

            const copies = [copy(child.stdout), copy(child.stderr)];

            try {
              const [exitCode] = await Promise.all([child.exited, Promise.all(copies)]);

              return exitCode;
            } catch (error) {
              stop("SIGTERM");
              await child.exited;
              await Promise.allSettled(copies);
              throw error;
            } finally {
              clearTimeout(timer);
              process.off("SIGINT", interrupt);
              process.off("SIGTERM", terminate);
            }
          } finally {
            log.close();
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
