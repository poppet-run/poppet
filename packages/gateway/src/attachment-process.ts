import { Effect } from "effect";

import { ChannelError } from "#src/channel";

export const attachmentFailure = (message: string) =>
  new ChannelError({ reason: "attachment", message });

export type AttachmentLauncher = (
  command: ReadonlyArray<string>,
  directory: string,
) => Bun.Subprocess<"ignore", "pipe", "pipe">;

export const launchAttachmentProcess: AttachmentLauncher = (command, directory) =>
  Bun.spawn([...command], {
    cwd: directory,
    // No provider credentials or inherited process configuration reach the decoder/parser.
    env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, LANG: "C.UTF-8" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const read = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- Count streamed bytes before reading more.
      const item = await reader.read();

      if (item.done) break;
      bytes += item.value.byteLength;

      if (bytes > 262144) throw attachmentFailure("Attachment processor output exceeds its limit.");
      chunks.push(item.value);
    }

    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/** Both pipes are bounded, and every exit kills and reaps the owned process. */
export const attachmentCommand = (
  command: ReadonlyArray<string>,
  directory: string,
  timeout: number,
  launch = launchAttachmentProcess,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => launch(command, directory),
          catch: () =>
            attachmentFailure(
              "Cannot launch the local attachment processor. Check its executable path.",
            ),
        }),
        (process) =>
          Effect.promise(async () => {
            process.kill("SIGKILL");
            await process.exited;
          }),
      );

      const abort = () => child.kill("SIGKILL");

      return yield* Effect.tryPromise({
        try: async (signal) => {
          let expired = false;
          signal.addEventListener("abort", abort, { once: true });

          const timer = setTimeout(() => {
            expired = true;
            abort();
          }, timeout);

          try {
            if (signal.aborted) abort();

            const [stdout, , code] = await Promise.all([
              read(child.stdout),
              read(child.stderr),
              child.exited,
            ]);

            if (expired)
              throw attachmentFailure(
                "Attachment processing timed out. Try a shorter document or recording.",
              );

            if (code !== 0 || signal.aborted)
              throw attachmentFailure(
                "The local attachment processor failed. Check the configured executables/model or try a different file.",
              );

            return stdout;
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        },
        catch: (cause) =>
          cause instanceof ChannelError
            ? cause
            : attachmentFailure(
                "Cannot run the local attachment processor. Check its executable and model paths.",
              ),
      });
    }),
  );
