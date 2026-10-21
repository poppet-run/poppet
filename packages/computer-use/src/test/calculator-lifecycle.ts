import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { Schema } from "effect";

import {
  alive,
  calculatorEnvironment,
  calculatorSession,
  openCalculatorDriver,
  type CalculatorCheck,
} from "#src/test/calculator-runtime";

const readPipe = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();

      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert(bytes <= 262144, "Lifecycle pipe exceeds 256 KiB.");
      chunks.push(chunk.value);
    }

    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

const waitGone = async (pid: number) => {
  for (let attempt = 0; alive(pid) && attempt < 100; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
  }

  return !alive(pid);
};

export const calculatorLifecycle = async (
  command: string,
  directory: string,
  entry: string,
  checks: CalculatorCheck[],
) => {
  await writeFile(`${directory}/invalid.rego`, "not a policy", { mode: 0o600 });

  for (const [name, environment] of [
    [
      "missing manifest approval",
      { ...calculatorEnvironment(directory), CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "0" },
    ],
    [
      "invalid configured policy",
      { ...calculatorEnvironment(directory), CUA_DRIVER_POLICY_FILE: `${directory}/invalid.rego` },
    ],
  ] as const) {
    let rejected = false;

    try {
      // eslint-disable-next-line no-await-in-loop
      const unexpected = await openCalculatorDriver(
        command,
        ["mcp", "--direct"],
        directory,
        new AbortController().signal,
        environment,
      );

      // eslint-disable-next-line no-await-in-loop
      await unexpected.close();
    } catch {
      rejected = true;
    }

    assert(rejected, `Driver accepted ${name}.`);
    checks.push({ name: `startup rejects ${name}`, status: "passed" });
  }

  const eof = Bun.spawn([command, "mcp", "--direct"], {
    cwd: directory,
    env: calculatorEnvironment(directory),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = Promise.all([readPipe(eof.stdout), readPipe(eof.stderr)]);
  // Observe rejection immediately while the process is still being reaped.
  void output.catch(() => eof.kill("SIGKILL"));
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    eof.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "poppet-calculator-eof", version: "0.0.0" } } })}\n`,
    );
    eof.stdin.end();

    const code = await Promise.race([
      eof.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Driver did not exit on stdin EOF.")), 5000);
      }),
    ]);

    assert.equal(code, 0, "EOF cleanup failed.");
    const [stdout] = await output;

    const response = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          result: Schema.Struct({
            serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
          }),
        }),
      ),
    )(stdout.trim().split("\n")[0]);

    assert.equal(response.result.serverInfo.name, "cua-driver");
    checks.push({ name: "stdin EOF exits the direct runtime without signals", status: "passed" });
  } finally {
    clearTimeout(timer);
    eof.kill("SIGKILL");
    await eof.exited;
    await output;
  }

  const abort = new AbortController();

  const cancelled = await openCalculatorDriver(
    command,
    ["mcp", "--direct"],
    directory,
    abort.signal,
  );

  try {
    const pending = cancelled.call("check_permissions", {
      prompt: false,
      probe_direct_capture: false,
      session: calculatorSession,
    });

    const settled = pending.then(
      () => false,
      () => true,
    );

    abort.abort();
    assert(await settled, "Cancelled request unexpectedly completed.");
  } finally {
    await cancelled.close();
  }

  checks.push({ name: "cancellation closes and reaps a directly owned runtime", status: "passed" });

  const owner = Bun.spawn(
    [process.execPath, "--no-env-file", entry, "--owner-driver", command, directory],
    {
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stderr = readPipe(owner.stderr);
  void stderr.catch(() => owner.kill("SIGKILL"));
  let driverPid: number | undefined;
  const reader = owner.stdout.getReader();

  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owner-exit probe did not start.")), 10000);
      }),
    ]);

    assert(!ready.done && ready.value.byteLength <= 1024, "Invalid owned-driver identity.");

    const pid = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) })),
    )(new TextDecoder().decode(ready.value));

    driverPid = pid.pid;
    assert(alive(driverPid), "Owner probe child is not running.");
    owner.kill("SIGKILL");
    await owner.exited;
    assert(await waitGone(driverPid), "Driver survived forced owner exit.");
    checks.push({ name: "forced owner exit closes its idle driver through EOF", status: "passed" });
  } finally {
    clearTimeout(timer);
    owner.kill("SIGKILL");
    await owner.exited;

    if (driverPid !== undefined && alive(driverPid)) process.kill(driverPid, "SIGKILL");

    if (driverPid !== undefined)
      assert(await waitGone(driverPid), "Owned driver survived fallback cleanup.");
    await reader.cancel();
    reader.releaseLock();
    await stderr;
  }
};
