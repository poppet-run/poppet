import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

export const calculatorCandidate = {
  version: "0.38.0",
  asset: "cua-driver-rs-0.38.0-darwin-arm64.tar.gz",
  assetSha256: "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72",
  executableSha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
  executableBytes: 80571376,
  teamIdentifier: "YCK386LBJ7",
  identifier: "cua-driver",
};

const executeFile = promisify(execFile);

/** Metadata commands never start MCP, request OS grants, or touch an application. */
export const calculatorMetadataCommand = async (
  executable: string,
  args: ReadonlyArray<string>,
  directory: string,
  signal: AbortSignal,
  timeout = 5000,
) => {
  try {
    const pending = executeFile(executable, [...args], {
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1" },
      encoding: "utf8",
      maxBuffer: 262144,
      timeout,
      killSignal: "SIGKILL",
      signal,
    });

    const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));

    try {
      return await pending;
    } finally {
      await closed;
    }
  } catch {
    throw new Error("Metadata command failed, was cancelled, timed out, or exceeded 256 KiB.");
  }
};

export const verifyCalculatorExecutable = async (command: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "Requires Apple silicon macOS.",
  );
  assert(isAbsolute(command), "Pass an absolute executable path.");
  const executable = await realpath(command);
  const info = await stat(executable);
  signal?.throwIfAborted();
  assert(
    info.isFile() && info.size === calculatorCandidate.executableBytes,
    "Unpinned executable.",
  );
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(executable, { signal })) hash.update(chunk);
  const executableSha256 = hash.digest("hex");
  assert.equal(executableSha256, calculatorCandidate.executableSha256, "Unpinned executable.");

  return executable;
};
