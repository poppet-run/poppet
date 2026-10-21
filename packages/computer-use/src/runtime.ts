import assert from "node:assert/strict";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Context, Effect } from "effect";

import { calculatorEnvironment, openCalculatorDriver, type CalculatorDriver } from "#src/driver";
import {
  calculatorCandidate,
  calculatorMetadataCommand,
  verifyCalculatorExecutable,
} from "#src/driver-pin";
import { computerFailure } from "#src/errors";

export { openCalculatorDriver } from "#src/driver";

export type ComputerLauncher = (
  command: string,
  directory: string,
  signal: AbortSignal,
) => Promise<CalculatorDriver>;

/** Trusted host dependency; fixtures can use stdio without a real desktop or OS grants. */
export class ComputerRuntime extends Context.Service<
  ComputerRuntime,
  {
    readonly open: ComputerLauncher;
    readonly leaseDirectory: string;
  }
>()("poppet/ComputerRuntime") {}

export const launchInstalledComputer: ComputerLauncher = async (command, directory, signal) => {
  const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const executable = await verifyCalculatorExecutable(command, startupSignal);

  const run = (path: string, args: ReadonlyArray<string>) =>
    calculatorMetadataCommand(path, args, directory, startupSignal);

  await run("/usr/bin/codesign", ["--verify", "--strict", executable]);
  const { stderr: signature } = await run("/usr/bin/codesign", ["-dv", "--verbose=2", executable]);
  assert.equal(/^TeamIdentifier=(.+)$/m.exec(signature)?.[1], calculatorCandidate.teamIdentifier);
  assert.equal(/^Identifier=(.+)$/m.exec(signature)?.[1], calculatorCandidate.identifier);
  assert.equal(
    (await run(executable, ["--version"])).stdout.trim(),
    `cua-driver ${calculatorCandidate.version}`,
  );

  return openCalculatorDriver(
    executable,
    ["mcp", "--direct"],
    directory,
    signal,
    calculatorEnvironment(directory),
    startupSignal,
  );
};

export const desktopLeaseDirectory = () => `/tmp/poppet-calculator-${process.getuid?.()}`;

export const acquireDesktopLease = (directory: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        assert(
          info.isDirectory() &&
            !info.isSymbolicLink() &&
            info.uid === process.getuid?.() &&
            (info.mode & 0o777) === 0o700,
        );
      },
      catch: () => computerFailure("tool-storage", "Cannot protect the computer desktop lease."),
    });
    yield* acquireOwnerLock(join(directory, "owner")).pipe(
      Effect.mapError((error) =>
        computerFailure(
          error.reason === "busy" ? "tool-permission" : "tool-storage",
          error.reason === "busy"
            ? "Another computer trial owns the desktop. Wait for it to finish."
            : "Cannot acquire the computer desktop lease.",
        ),
      ),
    );
  });
