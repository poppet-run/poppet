import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  calculatorCandidate,
  calculatorInputSchema,
  calculatorMetadataCommand,
  calculatorSchemaChecks,
  calculatorSchemaReport,
  calculatorToolNames,
} from "#src/test/calculator-check";

import fixture from "./test/fixtures/calculator-schemas.json";

test("the pinned Calculator schemas compile unchanged without certifying desktop checks", () => {
  expect(fixture.executableSha256).toBe(calculatorCandidate.executableSha256);
  const before = JSON.stringify(fixture);
  const report = calculatorSchemaReport(fixture.tools);

  expect(report).toMatchObject({
    stage: "22a",
    status: "ready",
    gate: "runtime-checks",
    unsupported: [],
    inference: false,
    desktopCalls: 0,
  });
  expect(report.checks).toEqual(
    calculatorToolNames.map((tool) => ({
      tool,
      originalInputSchema: true,
      strictWrapper: true,
    })),
  );
  expect(report.notRun).toContain("MCP handshake, discovery, and output schemas");
  expect(report.notRun).toContain("AX-only press and independent display readback");
  expect(JSON.stringify(fixture)).toBe(before);
});

test("metadata preserves the full schema and rejects wrong identities, malformed JSON and oversized output", () => {
  for (const tool of fixture.tools) {
    const metadata = `name: ${tool.name}\n\ndescription:\nUntrusted description\n\ninput_schema:\n${JSON.stringify(tool.inputSchema)}`;
    expect(calculatorInputSchema(tool.name, metadata)).toEqual(tool.inputSchema);
    expect(() => calculatorInputSchema("foreign", metadata)).toThrow("identity");
  }

  expect(() => calculatorInputSchema("click", "name: click\n")).toThrow("Missing");
  expect(() => calculatorInputSchema("click", "name: click\ninput_schema:\n[]")).toThrow();
  expect(() => calculatorInputSchema("click", "name: click\ninput_schema:\n{}")).toThrow("object");
  expect(() => calculatorInputSchema("click", "x".repeat(262145))).toThrow("256 KiB");
  expect(() => calculatorSchemaChecks(fixture.tools.slice(1))).toThrow("Missing");
  expect(() => calculatorSchemaChecks([...fixture.tools, fixture.tools[0]!])).toThrow("duplicate");
});

test("a future compatible schema cannot certify unperformed desktop checks", () => {
  const report = calculatorSchemaReport(
    calculatorToolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
  );

  expect(report).toMatchObject({
    status: "ready",
    gate: "runtime-checks",
    unsupported: [],
  });
  expect(report.notRun).toContain("direct-runtime TCC attribution without Screen Recording");
});

test("metadata commands exclude inherited secrets and Cua settings and disable telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-calculator-environment-"));
  const entry = join(directory, "fixture.ts");
  const saved = process.env.CUA_DRIVER_PERMISSION_MODE;
  const savedKey = process.env.POPPET_OPENROUTER_API_KEY;
  process.env.CUA_DRIVER_PERMISSION_MODE = "unrestricted";
  process.env.POPPET_OPENROUTER_API_KEY = "fixture-secret";

  await writeFile(entry, "console.log(JSON.stringify(process.env));");

  try {
    const result = await calculatorMetadataCommand(
      process.execPath,
      [entry],
      directory,
      new AbortController().signal,
    );

    const environment = JSON.parse(result.stdout);

    expect(environment.CUA_DRIVER_PERMISSION_MODE).toBeUndefined();
    expect(environment.POPPET_OPENROUTER_API_KEY).toBeUndefined();
    expect(environment.DO_NOT_TRACK).toBe("1");
    expect(environment.PATH).toBe("/usr/bin:/bin");
  } finally {
    if (saved === undefined) delete process.env.CUA_DRIVER_PERMISSION_MODE;
    else process.env.CUA_DRIVER_PERMISSION_MODE = saved;

    if (savedKey === undefined) delete process.env.POPPET_OPENROUTER_API_KEY;
    else process.env.POPPET_OPENROUTER_API_KEY = savedKey;

    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["timeout", "cancel", "flood"])(
  "metadata %s closes and reaps the child without exposing captured output",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-calculator-command-"));
    const entry = join(directory, "fixture.ts");
    const pidPath = join(directory, "pid");
    const abort = new AbortController();

    await writeFile(
      entry,
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      process.on("SIGTERM", () => {});
      if (${JSON.stringify(mode)} === "flood") process.stdout.write("private-metadata".repeat(30000));
      setInterval(() => {}, 1000);`,
    );

    try {
      const result = calculatorMetadataCommand(
        process.execPath,
        [entry],
        directory,
        abort.signal,
        1000,
      );

      // Attach the rejection handler before waiting for the cancellable child to start.
      const outcome = result.then(
        () => "unexpected success",
        (error: Error) => error.message,
      );

      if (mode === "cancel") {
        for (let attempt = 0; attempt < 100; attempt++) {
          // eslint-disable-next-line no-await-in-loop
          if (await Bun.file(pidPath).exists()) break;
          // eslint-disable-next-line no-await-in-loop
          await Bun.sleep(5);
        }

        abort.abort();
      }

      expect(await outcome).toBe(
        "Metadata command failed, was cancelled, timed out, or exceeded 256 KiB.",
      );
      const pid = Number(await readFile(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      abort.abort();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
