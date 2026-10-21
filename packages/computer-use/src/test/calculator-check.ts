import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { compileSchema, decodeArguments, definition } from "@poppet/mcp/catalog";
import { Effect, Schema } from "effect";

import { calculatorLifecycle } from "#src/test/calculator-lifecycle";
import {
  calculatorManifest,
  calculatorGuard,
  calculatorPolicy,
  openCalculatorDriver,
  runCalculatorTrial,
  type CalculatorCheck,
} from "#src/test/calculator-runtime";

export const calculatorCandidate = {
  version: "0.38.0",
  asset: "cua-driver-rs-0.38.0-darwin-arm64.tar.gz",
  assetSha256: "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72",
  executableSha256: "92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f",
  executableBytes: 80571376,
  teamIdentifier: "YCK386LBJ7",
  identifier: "cua-driver",
};

export const calculatorToolNames = [
  "check_permissions",
  "launch_app",
  "get_window_state",
  "click",
  "end_session",
] as const;

const pendingChecks = [
  "MCP handshake, discovery, and output schemas",
  "bounded manifest/policy identity and denied app/argument access",
  "direct-runtime TCC attribution without Screen Recording",
  "Calculator window binding and screenshot-free AX observation",
  "AX-only press and independent display readback",
  "stale tokens, screen lock, and revoked permissions",
  "runtime cancellation, EOF, forced owner exit, and desktop cleanup",
];

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

export const calculatorInputSchema = (name: string, output: string) => {
  assert(Buffer.byteLength(output) <= 262144, "Metadata exceeds 256 KiB.");
  assert(output.startsWith(`name: ${name}\n`), "Unexpected tool metadata identity.");
  const marker = "\ninput_schema:\n";
  const position = output.lastIndexOf(marker);
  assert(position >= 0, "Missing original input schema.");

  const schema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
    output.slice(position + marker.length),
  );

  assert.equal(schema.type, "object", "Tool input must be an object schema.");

  return schema;
};

/** Preserve the original schemas: an unsupported keyword is a failed gate, never stripped. */
export const calculatorSchemaChecks = (
  tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: Schema.JsonObject }>,
) => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    calculatorToolNames,
    "Missing, duplicate, or unexpected Calculator trial schemas.",
  );

  return tools.map((tool) => {
    let supported = false;

    try {
      compileSchema(tool.inputSchema);
      supported = true;
    } catch {
      // Retain the schema in evidence without copying server text into diagnostics.
    }

    const wrapper = definition("calculator-trial", tool.name, "", tool.inputSchema);
    const validate = compileSchema(wrapper.parameters);
    const argument = { input: "{}" };
    assert(validate(argument), "Strict tool wrapper rejected its JSON-string argument.");
    assert(!validate({ ...argument, session: "foreign" }), "Tool wrapper permits extra fields.");
    assert.deepEqual(decodeArguments(JSON.stringify(argument)), {});

    return { tool: tool.name, originalInputSchema: supported, strictWrapper: true };
  });
};

export const calculatorSchemaReport = (
  tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: Schema.JsonObject }>,
) => {
  const checks = calculatorSchemaChecks(tools);
  const unsupported = checks.flatMap((check) => (check.originalInputSchema ? [] : [check.tool]));

  return {
    stage: "22a",
    status: unsupported.length > 0 ? "blocked" : "ready",
    gate: unsupported.length > 0 ? "input-schema" : "runtime-checks",
    reason:
      unsupported.length > 0
        ? "Original driver schemas are unsupported by Poppet's MCP compiler. No desktop calls were made."
        : "Metadata passed; this probe does not certify the pending desktop checks.",
    unsupported,
    checks,
    notRun: pendingChecks,
    inference: false,
    desktopCalls: 0,
  };
};

export const verifyCalculatorExecutable = async (command: string) => {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "Requires Apple silicon macOS.",
  );
  assert(isAbsolute(command), "Pass an absolute executable path.");
  const executable = await realpath(command);
  const info = await stat(executable);
  assert(
    info.isFile() && info.size === calculatorCandidate.executableBytes,
    "Unpinned executable.",
  );
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const executableSha256 = hash.digest("hex");
  assert.equal(executableSha256, calculatorCandidate.executableSha256, "Unpinned executable.");

  return executable;
};

export const checkCalculator = async (
  command: string,
  evidenceDirectory: string,
  scenario: "normal" | "screen-locked" | "accessibility-denied" = "normal",
  lockedTarget?: { readonly pid: number; readonly windowId: number },
) => {
  assert(isAbsolute(evidenceDirectory), "Pass an absolute evidence path.");
  const executable = await verifyCalculatorExecutable(command);

  // A fresh directory prevents overwriting prior evidence or following an existing symlink.
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const directory = await mkdtemp("/tmp/pc-22a-");
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300000)]);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    const run = (path: string, args: ReadonlyArray<string>) =>
      calculatorMetadataCommand(path, args, directory, signal);

    await run("/usr/bin/codesign", ["--verify", "--strict", executable]);

    const { stderr: signature } = await run("/usr/bin/codesign", [
      "-dv",
      "--verbose=2",
      executable,
    ]);

    assert.equal(/^TeamIdentifier=(.+)$/m.exec(signature)?.[1], calculatorCandidate.teamIdentifier);
    assert.equal(/^Identifier=(.+)$/m.exec(signature)?.[1], calculatorCandidate.identifier);
    const { stdout: version } = await run(executable, ["--version"]);
    assert.equal(version.trim(), `cua-driver ${calculatorCandidate.version}`);
    const { stdout: osVersion } = await run("/usr/bin/sw_vers", ["-productVersion"]);

    const { stdout: calculatorVersion } = await run("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      "/System/Applications/Calculator.app/Contents/Info.plist",
    ]);

    const metadata = await Promise.allSettled(
      calculatorToolNames.map(async (name) => ({
        name,
        inputSchema: calculatorInputSchema(
          name,
          (await run(executable, ["describe", name])).stdout,
        ),
      })),
    );

    const tools = metadata.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    assert.equal(tools.length, calculatorToolNames.length, "Tool metadata failed.");

    const schemaReport = calculatorSchemaReport(tools);
    const checks: CalculatorCheck[] = [];
    const calls: Array<{ tool: string; outcome: string }> = [];
    let failure: string | null = null;
    let binding: { readonly pid: number; readonly windowId: number } | null = null;
    let discovery: ReadonlyArray<Schema.JsonObject> = [];
    await writeFile(join(directory, "manifest.json"), JSON.stringify(calculatorManifest), {
      mode: 0o600,
    });
    await writeFile(join(directory, "policy.rego"), calculatorPolicy, { mode: 0o600 });
    await writeFile(join(directory, "guard.yaml"), JSON.stringify(calculatorGuard), {
      mode: 0o600,
    });

    try {
      assert.equal(schemaReport.unsupported.length, 0, "Unsupported original schema.");
      const lease = `/tmp/poppet-calculator-${process.getuid?.()}`;
      await mkdir(lease, { recursive: true, mode: 0o700 });
      const leaseInfo = await lstat(lease);
      assert(
        leaseInfo.isDirectory() &&
          leaseInfo.uid === process.getuid?.() &&
          (leaseInfo.mode & 0o777) === 0o700,
        "Unsafe desktop lease directory.",
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireOwnerLock(join(lease, "owner"));
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await rm(directory, { recursive: true, force: true });
                checks.push({
                  name: "private runtime files removed before desktop lease release",
                  status: "passed",
                });
              }),
            );
            yield* Effect.tryPromise({
              try: async () => {
                const driver = await openCalculatorDriver(
                  executable,
                  ["mcp", "--direct"],
                  directory,
                  signal,
                );

                try {
                  const trial = await runCalculatorTrial(driver, checks, scenario, lockedTarget);
                  binding = trial.binding;
                  discovery = trial.tools.map((tool) =>
                    Schema.decodeUnknownSync(Schema.JsonObject)(tool),
                  );
                } finally {
                  calls.push(...driver.calls);
                  await driver.close();
                  checks.push({
                    name: "direct child reaped before desktop lease release",
                    status: "passed",
                  });
                }

                await calculatorLifecycle(executable, directory, import.meta.filename, checks);
              },
              catch: (cause) =>
                cause instanceof Error ? cause : new Error("Calculator runtime check failed."),
            });
          }),
        ),
      );
    } catch (error) {
      failure =
        error instanceof Error && error.name === "AssertionError"
          ? (error.message.split("\n")[0] ?? "Runtime assertion failed.")
          : "Runtime request failed; dispatched actions may have uncertain effects. No action was retried.";
    }

    const manual = ["normal", "screen-locked", "accessibility-denied"].flatMap((value) =>
      value === scenario ? [] : [`${value} scenario`],
    );

    if (failure) manual.unshift("remaining checks after the reported runtime failure");

    let runtimeStatus = "passed";

    if (failure) runtimeStatus = "blocked";
    else if (checks.some((check) => check.status === "pending")) runtimeStatus = "pending";

    const report = {
      ...schemaReport,
      status: runtimeStatus,
      gate: failure
        ? "runtime"
        : runtimeStatus === "pending"
          ? "manual-validation"
          : "scenario-complete",
      reason: failure,
      candidate: calculatorCandidate,
      signatureVerified: true,
      osVersion: osVersion.trim(),
      calculatorVersion: calculatorVersion.trim(),
      arch: process.arch,
      scenario,
      runtimeChecks: checks,
      calls,
      binding,
      notRun: manual,
      manifestSha256: createHash("sha256").update(JSON.stringify(calculatorManifest)).digest("hex"),
      policySha256: createHash("sha256").update(calculatorPolicy).digest("hex"),
      guardSha256: createHash("sha256").update(JSON.stringify(calculatorGuard)).digest("hex"),
      desktopCalls: calls.filter((call) =>
        ["launch_app", "get_window_state", "click"].includes(call.tool),
      ).length,
    };

    await writeFile(
      join(evidenceDirectory, "schemas.json"),
      `${JSON.stringify(tools, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await writeFile(
      join(evidenceDirectory, "discovery.json"),
      `${JSON.stringify(discovery, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(evidenceDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );

    return report;
  } finally {
    abort.abort();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await rm(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const [command, evidenceDirectory, mode, pid, windowId, extra] = Bun.argv.slice(2);

  if (command === "--owner-driver" && evidenceDirectory && mode && !pid) {
    const executable = await verifyCalculatorExecutable(evidenceDirectory);

    const driver = await openCalculatorDriver(
      executable,
      ["mcp", "--direct"],
      mode,
      new AbortController().signal,
    );

    try {
      console.log(JSON.stringify({ pid: driver.pid }));
      await Bun.sleep(60000);
    } finally {
      await driver.close();
    }
  } else if (
    !command ||
    !evidenceDirectory ||
    extra ||
    (mode === "--screen-locked" &&
      [pid, windowId].some(
        (value) => !value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)),
      )) ||
    (mode !== undefined && mode !== "--screen-locked" && mode !== "--accessibility-denied") ||
    (mode !== "--screen-locked" && (pid !== undefined || windowId !== undefined))
  ) {
    console.error(
      "Pass the pinned executable and a new evidence directory; optionally --screen-locked PID WINDOW_ID or --accessibility-denied.",
    );
    process.exitCode = 2;
  } else {
    try {
      let scenario: "normal" | "screen-locked" | "accessibility-denied" = "normal";

      if (mode === "--screen-locked") scenario = "screen-locked";
      else if (mode === "--accessibility-denied") scenario = "accessibility-denied";

      const target =
        scenario === "screen-locked" ? { pid: Number(pid), windowId: Number(windowId) } : undefined;

      const report = await checkCalculator(command, evidenceDirectory, scenario, target);
      console.log(
        `Calculator ${scenario} probe ${report.status}. Private evidence saved. No inference or automatic action retries.`,
      );
      process.exitCode = report.status === "passed" ? 0 : 1;
    } catch (error) {
      let detail = "preflight error";

      if (error instanceof assert.AssertionError) detail = error.message.split("\n")[0] ?? detail;
      else if (
        error instanceof Error &&
        "code" in error &&
        ["EEXIST", "ENOENT", "EACCES", "EPERM"].includes(String(error.code))
      )
        detail = String(error.code);
      else if (error instanceof Error && error.message.startsWith("Metadata command failed"))
        detail = "metadata command failed";
      console.error(
        `Calculator probe failed (${detail}). Check any saved report before another attempt. No action was retried.`,
      );
      process.exitCode = 1;
    }
  }
}
