import { spawn } from "node:child_process";

import { AgentError, Bash, type BashArguments, type BashResult } from "@poppet/agent";
import { Effect, Layer } from "effect";

/** One process group per invocation; timeout, cancellation, and exit reap its children. */
export const executeBash = (
  request: BashArguments,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BashResult> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(
        new AgentError({
          reason: "command-unavailable",
          message: "Command cancelled before execution.",
        }),
      );

      return;
    }

    const environment = { ...process.env };
    // Noninteractive startup files must not execute commands outside the reviewed script.
    delete environment.BASH_ENV;
    delete environment.ENV;

    const child = spawn(
      "/bin/bash",
      ["--noprofile", "--norc", "-o", "pipefail", "-c", request.command],
      {
        cwd: request.cwd,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let expired = false;
    // JSON escaping can expand each retained byte sixfold; keep both pipes within the result budget.
    const limit = Math.max(1, Math.floor((maxBytes - 128) / 12));

    const stop = () => {
      if (child.pid === undefined) return;

      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const collect = (current: Buffer, chunk: Buffer) => {
      const available = limit - current.length;
      truncated ||= chunk.length > available;

      return Buffer.concat([current, chunk.subarray(0, Math.max(0, available))]);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    signal.addEventListener("abort", stop, { once: true });

    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, request.timeoutSeconds * 1000);

    // A shell can exit while a background child still holds its output pipes.
    child.once("exit", stop);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };

    child.once("error", () => {
      cleanup();
      reject(
        new AgentError({
          reason: "command-unavailable",
          message: "Could not start Bash. Check /bin/bash and the working directory.",
        }),
      );
    });
    child.once("close", (code) => {
      cleanup();

      if (expired || signal.aborted || code === null) {
        reject(
          new AgentError({
            reason: "tool-uncertain",
            message:
              "Bash was interrupted or timed out. It may have changed the machine; inspect the result before retrying.",
          }),
        );

        return;
      }

      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: code,
        truncated,
      });
    });

    if (signal.aborted) stop();
  });

export const BashLive = Layer.succeed(Bash, {
  run: (request, maxBytes) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const controller = new AbortController();

        return { controller, execution: executeBash(request, maxBytes, controller.signal) };
      }),
      ({ execution }) =>
        Effect.tryPromise({
          try: () => execution,
          catch: (cause) =>
            cause instanceof AgentError
              ? cause
              : new AgentError({
                  reason: "tool-uncertain",
                  message:
                    "Bash execution failed unexpectedly. Inspect the machine before retrying.",
                }),
        }),
      ({ controller, execution }) =>
        Effect.promise(async () => {
          controller.abort();
          await execution.catch(() => undefined);
        }),
    ),
});
