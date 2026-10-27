import { createConnection } from "node:net";

import { readBoundedText, runBounded } from "@poppet/io";
import { Effect, type Schema } from "effect";

import { BrowserError } from "#src/errors";

export const agentBrowserVersion = "0.39.4";

export const chromiumVersion = "156.0.8078.47";

const maxProcessBytes = 262144;

export const browserFailure = (reason: BrowserError["reason"], message: string) =>
  new BrowserError({ reason, message });

export type BrowserLauncher = (
  command: ReadonlyArray<string>,
  directory: string,
  environment: Record<string, string>,
) => Bun.Subprocess<"ignore", "pipe", "pipe">;

/** Only the fixed executable and argument array reach the subprocess API. */
export const launchBrowserProcess: BrowserLauncher = (command, directory, environment) =>
  Bun.spawn([...command], {
    cwd: directory,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

const outputTooLarge = () =>
  browserFailure("tool-limit", "Browser command output exceeds 256 KiB.");

/** Drains both pipes under a byte cap, kills a cancelled command, and always reaps it. */
export const runBrowserCommand = (
  command: ReadonlyArray<string>,
  directory: string,
  environment: Record<string, string>,
  launch: BrowserLauncher = launchBrowserProcess,
  timeout = 35000,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const { stdout, code, expired, aborted } = await runBounded(
        launch(command, directory, environment),
        { signal, timeout, maxBytes: maxProcessBytes, tooLarge: outputTooLarge },
      );

      if (expired || aborted)
        throw browserFailure("tool-uncertain", "Browser command stopped; effects may be unknown.");

      if (code !== 0 && stdout.length === 0)
        throw browserFailure("tool-uncertain", "Browser command failed; effects may be unknown.");

      return stdout;
    },
    catch: (cause) =>
      cause instanceof BrowserError
        ? cause
        : browserFailure("tool-uncertain", "Browser command failed; effects may be unknown."),
  });

/** Own the pinned native daemon directly, rather than letting short-lived CLI commands detach it. */
export const startBrowserDaemon = (
  executable: string,
  directory: string,
  environment: Record<string, string>,
  launch: BrowserLauncher,
) => {
  const child = launch([executable], directory, { ...environment, AGENT_BROWSER_DAEMON: "1" });
  let failed = false;
  let exited = false;

  const pipes = Promise.all([
    readBoundedText(child.stdout, maxProcessBytes, outputTooLarge),
    readBoundedText(child.stderr, maxProcessBytes, outputTooLarge),
  ]).catch(() => {
    failed = true;
    child.kill("SIGTERM");
  });

  void child.exited.then(() => {
    exited = true;

    return undefined;
  });

  let closing: Promise<void> | undefined;

  return {
    pid: child.pid,
    alive: () => !failed && !exited,
    stop: () => {
      closing ??= (async () => {
        // SIGTERM runs the pinned daemon's browser-tree cleanup, including during a pending action.
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            child.exited,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("Browser daemon did not finish graceful cleanup."));
              }, 40000);
            }),
          ]);
          await pipes;
        } finally {
          clearTimeout(timer);
          await child.exited;
        }
      })();

      return closing;
    },
  };
};

const connectionFailure = () =>
  browserFailure(
    "tool-uncertain",
    "Browser connection stopped; effects may be unknown. No action was retried.",
  );

/** Send one fixed native command to the owned daemon. A lost response is never replayed. */
export const runBrowserRequest = (
  socketPath: string,
  request: Schema.JsonObject,
  timeout = 35000,
) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPath);
        const chunks: Buffer[] = [];
        let bytes = 0;
        let complete = false;
        const abort = () => socket.destroy(connectionFailure());
        const timer = setTimeout(abort, timeout);

        signal.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;

          if (bytes > maxProcessBytes) {
            socket.destroy(browserFailure("tool-limit", "Browser response exceeds 256 KiB."));

            return;
          }

          chunks.push(chunk);

          if (chunk.includes(10)) {
            complete = true;

            try {
              resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            } catch {
              reject(connectionFailure());
            }

            socket.destroy();
          }
        });
        socket.once("error", reject);
        socket.once("close", () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);

          if (!complete) reject(connectionFailure());
        });

        if (signal.aborted) abort();
      }),
    catch: (cause) =>
      cause instanceof BrowserError
        ? cause
        : browserFailure("tool-uncertain", "Browser connection failed; no action was retried."),
  });
