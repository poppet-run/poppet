import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { AgentError, Bash, type BashArguments, type BashResult } from "@poppet/agent";
import { Effect, Layer } from "effect";

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

    const stdout = { bytes: Buffer.alloc(0), truncated: false };
    const stderr = { bytes: Buffer.alloc(0), truncated: false };
    let expired = false;
    const limit = Math.max(1, Math.floor((maxBytes - 128) / 12));

    const stop = () => {
      if (child.pid === undefined) return;

      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const collect = (output: typeof stdout, chunk: Buffer) => {
      const available = limit - output.bytes.length;
      output.truncated ||= chunk.length > available;

      if (available <= 0) return;
      output.bytes = Buffer.concat([output.bytes, chunk.subarray(0, available)]);
    };

    const decode = (output: typeof stdout) =>
      output.truncated
        ? new StringDecoder("utf8").write(output.bytes)
        : output.bytes.toString("utf8");

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    signal.addEventListener("abort", stop, { once: true });

    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, request.timeoutSeconds * 1000);

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
        stdout: decode(stdout),
        stderr: decode(stderr),
        exitCode: code,
        truncated: stdout.truncated || stderr.truncated,
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
