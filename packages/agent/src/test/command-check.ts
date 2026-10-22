import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandProposal } from "@poppet/store";

import { runCommandProcess } from "../command-process";

const directory = await mkdtemp(join(tmpdir(), "poppet-command-check-"));

try {
  const path = await realpath(directory);
  const info = await stat(path);
  const root = { path, device: info.dev.toString(), inode: info.ino.toString() };

  const payload: CommandProposal = {
    version: 1,
    type: "execute_command",
    policy: 1,
    request: { executable: process.execPath, args: [], cwd: "." },
    executable: { path: process.execPath, device: "0", inode: "0", digest: "probe" },
    cwd: root,
    grant: { root },
    project: null,
    environment: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      HOME: "private-temporary",
      TMPDIR: "private-temporary",
    },
    timeoutMs: 60000,
    outputBytes: 65536,
  };

  const fixture = join(import.meta.dir, "command-fixture.ts");

  const run = (mode: string, args: string[] = [], signal = new AbortController().signal) =>
    runCommandProcess(
      { ...payload, request: { ...payload.request, args: [fixture, mode, ...args] } },
      signal,
      { timeoutMs: 200, outputBytes: 65536, graceMs: 100, reapMs: 1500 },
    );

  const report = await run("report", ["", "a b", "$(touch nowhere)", "λ"]);
  assert.equal(report.exitCode, 0);
  assert.equal(report.cleanup, true);
  const data = JSON.parse(report.stdout);
  assert.deepEqual(data.args, ["", "a b", "$(touch nowhere)", "λ"]);
  assert.equal(data.cwd, path);
  assert.equal(data.env.PATH, "/usr/bin:/bin");
  assert.equal(data.env.POPPET_PROVIDER, undefined);
  assert.equal(data.env.HOME.startsWith(report.temporaryDirectory), true);
  assert.equal(report.stderr.trim(), "separate stderr");
  const failed = await run("fail");
  assert.equal(failed.exitCode, 7);

  const missing = await runCommandProcess(
    { ...payload, executable: { ...payload.executable, path: join(path, "missing") } },
    new AbortController().signal,
  );

  assert.equal(missing.spawned, false);
  assert.equal(missing.reason, "spawn-failed");

  for (const mode of ["stubborn", "descendant", "orphan", "flood"]) {
    // Confirm cleanup before launching the next fixture group.
    // eslint-disable-next-line no-await-in-loop
    const result = await run(mode);
    assert.equal(result.spawned, true, mode);
    assert.equal(result.cleanup, true, `${mode}: ${JSON.stringify(result)}`);
    assert.equal(result.finishedAt - result.startedAt < 2200, true, mode);
    assert.equal(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 65536,
      true,
      mode,
    );

    if (mode === "flood") assert.equal(result.truncated, true);
  }

  const controller = new AbortController();
  const pending = run("stubborn", [], controller.signal);
  setTimeout(() => controller.abort(), 75);
  const cancelled = await pending;
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.cleanup, true);
  const beforeSpawn = new AbortController();
  beforeSpawn.abort();
  const unstarted = await run("report", [], beforeSpawn.signal);
  assert.equal(unstarted.spawned, false);
  assert.equal(unstarted.reason, "cancelled-before-spawn");
  console.log(
    `Command compatibility passed: Bun ${Bun.version}, ${process.platform}/${process.arch}, node:child_process POSIX groups.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
