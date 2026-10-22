import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandProposal } from "@poppet/store";

export interface CommandOutcome {
  readonly spawned: boolean;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reason: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly invalidText: boolean;
  readonly cleanup: boolean;
  readonly temporaryDirectory: string | null;
}

/** An owned POSIX process group, with bounded pipes and cleanup, not a sandbox. */
export const runCommandProcess = async (
  payload: CommandProposal,
  signal: AbortSignal,
  limits: { timeoutMs: number; outputBytes: number; graceMs: number; reapMs: number } = {
    timeoutMs: payload.timeoutMs,
    outputBytes: payload.outputBytes,
    graceMs: 2000,
    reapMs: 3000,
  },
): Promise<CommandOutcome> => {
  const startedAt = Date.now();
  let directory: string | null = null;
  let cleanup = true;
  let spawned = false;
  let reason: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let bytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let truncated = false;

  try {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Unsupported command platform.");
    directory = await mkdtemp(join(tmpdir(), "poppet-command-"));
    await chmod(directory, 0o700);
    const home = join(directory, "home");
    const temporary = join(directory, "tmp");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(temporary, { mode: 0o700 })]);

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        reason = "cancelled-before-spawn";
        resolve();

        return;
      }

      const child = spawn(payload.executable.path, [...payload.request.args], {
        cwd: payload.cwd.path,
        env: {
          PATH: payload.environment.PATH,
          LANG: payload.environment.LANG,
          HOME: home,
          TMPDIR: temporary,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let finished = false;
      let exited = false;
      let closed = false;
      let stopping = false;
      let forceAt = 0;
      let stopAt = 0;

      const alive = () => {
        if (!spawned || child.pid === undefined) return false;

        try {
          process.kill(-child.pid, 0);

          return true;
        } catch (cause) {
          return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
        }
      };

      const send = (value: NodeJS.Signals) => {
        if (!spawned || child.pid === undefined) return;

        try {
          process.kill(-child.pid, value);
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
            cleanup = false;
        }
      };

      const stop = (why: string | null) => {
        reason ??= why;

        if (stopping) return;
        stopping = true;
        forceAt = performance.now() + limits.graceMs;
        stopAt = forceAt + limits.reapMs;
        send("SIGTERM");
      };

      const abort = () => stop("cancelled");

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(tick);
        signal.removeEventListener("abort", abort);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve();
      };

      const capture = (target: Buffer[], data: Buffer) => {
        const available = Math.max(0, limits.outputBytes - bytes);

        if (available > 0) target.push(Buffer.from(data.subarray(0, available)));
        bytes += data.length;

        if (bytes > limits.outputBytes) {
          truncated = true;
          stop("output-limit");
        }
      };

      child.stdout.on("data", (data: Buffer) => capture(stdout, data));
      child.stderr.on("data", (data: Buffer) => capture(stderr, data));
      child.stdout.on("error", () => stop("output-read-failed"));
      child.stderr.on("error", () => stop("output-read-failed"));
      child.on("spawn", () => {
        spawned = true;

        if (stopping) send("SIGTERM");
        else if (signal.aborted) abort();
      });
      child.on("error", () => {
        reason = spawned ? "process-error" : "spawn-failed";
        exited = true;
        stop(reason);
      });
      child.on("exit", (code, value) => {
        exited = true;
        exitCode = code;
        exitSignal = value;
        stop(null);
      });
      child.on("close", () => {
        closed = true;
      });
      const deadline = setTimeout(() => stop("timeout"), limits.timeoutMs);

      const tick = setInterval(() => {
        if (exited && closed && !alive()) {
          finish();

          return;
        }

        if (!stopping) return;

        if (performance.now() >= forceAt) send("SIGKILL");

        if (performance.now() >= stopAt) {
          if (!exited || alive()) {
            cleanup = false;
            reason ??= "cleanup-unconfirmed";
          }

          finish();
        }
      }, 10);

      signal.addEventListener("abort", abort, { once: true });
    });
  } catch {
    reason ??= spawned ? "process-error" : "spawn-failed";
  } finally {
    if (directory !== null)
      await rm(directory, { recursive: true, force: true }).catch(() => {
        cleanup = false;
      });
  }

  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  let invalidText = false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(out);
    new TextDecoder("utf-8", { fatal: true }).decode(err);
  } catch {
    invalidText = true;
  }

  return {
    spawned,
    startedAt,
    finishedAt: Date.now(),
    exitCode,
    signal: exitSignal,
    reason,
    stdout: out.toString("utf8"),
    stderr: err.toString("utf8"),
    bytes,
    truncated,
    invalidText,
    cleanup,
    temporaryDirectory: directory,
  };
};
