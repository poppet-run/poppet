import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { AppConfig, ConfigIdentity, ConfigSourceLive } from "@poppet/config";
import { gatewaySchema } from "@poppet/gateway";
import { StoreLive, migrate } from "@poppet/store";
import { taskSchema } from "@poppet/tasks";
import { serveWorker, workerSocketPath } from "@poppet/worker";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { createCLIContext } from "#src/commands/context";
import { collectDoctor, inspectCheck } from "#src/commands/doctor/collect";
import { doctorReport, finding, renderDoctor } from "#src/commands/doctor/report";
import { doctorSnapshot, gatewayObservation } from "#src/commands/doctor/worker";
import { providers } from "#src/providers";

const context = createCLIContext(
  providers,
  () => Effect.void,
  () => Effect.die("Unexpected worker mutation"),
  [],
  Effect.succeed(null),
  () => Effect.void,
);

const service = () =>
  Effect.succeed(finding("worker.service", "skipped", "local", "No installed service."));

const collect = (directory: string) =>
  collectDoctor(context, service).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ POPPET_DATA_DIR: directory }),
    ),
  );

const fixture = () => mkdtemp(join(tmpdir(), "poppet-doctor-"));

const configure = (directory: string) =>
  writeFile(join(directory, "config.json"), JSON.stringify({ provider: "openrouter" }), {
    mode: 0o600,
  });

const check = (report: ReturnType<typeof doctorReport>, id: string) =>
  report.checks.find((item) => item.id === id)!;

describe("doctor", () => {
  test("human reports put actionable findings first without losing details or changing JSON", () => {
    const report = doctorReport(
      [
        finding("configuration", "ok", "local", "Settings are valid."),
        finding("mcp", "skipped", "local", "No MCP servers are enabled."),
        finding(
          "authentication",
          "warning",
          "saved",
          "The saved access token has expired and needs attention before the next request.",
          "Run poppet provider login openai-chatgpt.",
        ),
        finding(
          "worker.socket",
          "error",
          "not-checked",
          "Worker inspection timed out.",
          "Run poppet worker status.",
          true,
        ),
      ],
      "/tmp/example",
    );

    const before = JSON.stringify(report);
    const plain = renderDoctor(report, false, 64);
    const normalized = plain.replace(/\s+/gu, " ");

    expect(plain).toContain("1 passed, 1 warning, 0 errors, 1 not checked, 1 skipped");
    expect(plain).toContain("Could not check");
    expect(plain).toContain("UNKNOWN");
    expect(plain).not.toContain("ERROR");
    expect(report.exitCode).toBe(2);
    expect(report.checks[3]?.status).toBe("error");
    expect(plain.indexOf("Needs attention")).toBeLessThan(plain.indexOf("Passed"));
    expect(plain.indexOf("Provider sign-in")).toBeLessThan(plain.indexOf("Configuration"));

    for (const entry of report.checks) {
      expect(normalized).toContain(entry.message);

      if (entry.nextStep !== null) expect(normalized).toContain(`Next: ${entry.nextStep}`);
    }

    expect(plain.split("\n").every((line) => line.length <= 64)).toBe(true);
    expect(stripVTControlCharacters(renderDoctor(report, true, 64))).toBe(plain);
    expect(JSON.stringify(report)).toBe(before);
  });

  test("expired ChatGPT credentials are reported without refresh or rewriting", async () => {
    const directory = await fixture();

    try {
      await mkdir(join(directory, "auth"), { mode: 0o700 });
      const path = join(directory, "auth/connection.json");

      const text = JSON.stringify({
        version: 1,
        hostId: "urn:uuid:12345678-1234-4123-8123-123456789012",
        clientId: "client",
        identity: { subject: "owner", email: "private@example.com" },
        credentials: {
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
          idToken: "secret-id",
          expiresAt: 1,
          scopes: ["chatgpt.tokens.use.direct"],
        },
        verification: null,
      });

      await writeFile(path, text, { mode: 0o600 });
      const report = await Effect.runPromise(collect(directory));
      expect(check(report, "authentication").status).toBe("warning");
      expect(check(report, "authentication").message).toContain("expired");
      expect(JSON.stringify(report)).not.toMatch(/secret-|private@example/);
      expect(await readFile(path, "utf8")).toBe(text);
      expect(await readdir(join(directory, "auth"))).toEqual(["connection.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("unusable MCP and invalid context files produce independent findings", async () => {
    const directory = await fixture();

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          mcpServers: [
            { id: "missing", enabled: true, command: "/missing/doctor-mcp", args: [], tools: [] },
          ],
        }),
      );
      await writeFile(join(directory, "profile.md"), Buffer.from([0xff]));
      const report = await Effect.runPromise(collect(directory));
      expect(check(report, "configuration").status).toBe("ok");
      expect(check(report, "mcp").status).toBe("warning");
      expect(check(report, "context").incomplete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("gateway observations expose connection failures without adapter error text", () => {
    expect(
      gatewayObservation({
        channels: [
          { enabled: true, connected: false, error: "secret" },
          { enabled: false, error: "secret" },
          { enabled: true },
        ],
      }),
    ).toEqual({ enabled: 2, disconnected: 1, configurationErrors: 1, unknown: 1 });
  });
  test("missing installation stays absent and reports setup guidance", async () => {
    const root = await fixture();

    try {
      const report = await Effect.runPromise(collect(join(root, "absent")));
      expect(report.exitCode).toBe(1);
      expect(check(report, "installation").nextStep).toContain("poppet setup");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed configuration never leaks keys or values and independent checks still run", async () => {
    const directory = await fixture();

    try {
      await writeFile(
        join(directory, "config.json"),
        '{"secret-key":"secret-value","provider":{"nested":"private"}}',
      );
      const before = await readFile(join(directory, "config.json"));
      const report = await Effect.runPromise(collect(directory));
      expect(report.exitCode).toBe(2);
      expect(check(report, "configuration").status).toBe("error");
      expect(check(report, "worker.service").status).toBe("skipped");
      expect(check(report, "worker.socket").status).toBe("warning");
      expect(JSON.stringify(report) + renderDoctor(report)).not.toMatch(
        /secret-key|secret-value|nested|private/,
      );
      expect(await readFile(join(directory, "config.json"))).toEqual(before);
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("credential inspection leaves unsafe permissions and bytes unchanged", async () => {
    const directory = await fixture();

    try {
      await configure(directory);
      await mkdir(join(directory, "auth"), { mode: 0o700 });
      const path = join(directory, "auth/openrouter.json");
      const text = JSON.stringify({ version: 1, provider: "openrouter", key: "super-secret" });
      await writeFile(path, text, { mode: 0o644 });
      await chmod(path, 0o644);
      const report = await Effect.runPromise(collect(directory));
      expect(check(report, "authentication").incomplete).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      expect(await readFile(path, "utf8")).toBe(text);
      expect(JSON.stringify(report)).not.toContain("super-secret");
      await chmod(path, 0o600);
      const safe = await Effect.runPromise(collect(directory));
      expect(check(safe, "authentication").status).toBe("ok");
      expect(await readdir(join(directory, "auth"))).toEqual(["openrouter.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("offline databases and WAL files are left untouched", async () => {
    const directory = await fixture();

    try {
      await configure(directory);
      await mkdir(join(directory, "store"), { mode: 0o700 });
      const files = ["poppet.sqlite", "poppet.sqlite-wal"];
      await Promise.all(
        files.map((name) => writeFile(join(directory, "store", name), "unknown-newer-schema")),
      );
      const report = await Effect.runPromise(collect(directory));
      expect(report.exitCode).toBe(2);
      expect(check(report, "tasks").message).toContain("needs a responding worker");
      expect((await readdir(join(directory, "store"))).toSorted()).toEqual(files.toSorted());

      expect(
        await Promise.all(files.map((name) => readFile(join(directory, "store", name), "utf8"))),
      ).toEqual(files.map(() => "unknown-newer-schema"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["healthy", "mismatch", "old", "secret", "oversized"])(
    "worker response %s produces bounded findings without replay",
    async (mode) => {
      const directory = await fixture();

      try {
        await configure(directory);
        await mkdir(join(directory, "auth"), { mode: 0o700 });
        await writeFile(
          join(directory, "auth/openrouter.json"),
          JSON.stringify({ version: 1, provider: "openrouter", key: "secret" }),
          { mode: 0o600 },
        );
        await mkdir(join(directory, "store"), { mode: 0o700 });

        const report = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const identity = yield* ConfigIdentity.pipe(
                Effect.provide(ConfigSourceLive),
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown({ POPPET_DATA_DIR: directory }),
                ),
              );

              yield* serveWorker(workerSocketPath(directory), (request) => {
                expect(new URL(request.url).pathname).toBe("/v1/doctor");

                if (mode === "old") return Effect.succeed(new Response("secret", { status: 404 }));

                if (mode === "oversized") return Effect.succeed(new Response("s".repeat(40000)));

                return Effect.succeed(
                  Response.json({
                    version: 1,
                    identity: mode === "mismatch" ? "0".repeat(64) : identity,
                    observedAt: 1234,
                    tasks: { failed: 0, interrupted: 0, running: 0, nextAt: null },
                    gateway: { enabled: 0, disconnected: 0, unknown: 0, configurationErrors: 0 },
                    holds: [],
                    holdsOmitted: 0,
                    delivery: { pending: 0, failed: 0, uncertain: 0 },
                    secret: mode === "secret" ? "must-not-appear" : null,
                  }),
                );
              });

              return yield* collect(directory);
            }),
          ),
        );

        if (mode === "healthy" || mode === "secret") {
          expect(report.exitCode).toBe(0);
          expect(check(report, "tasks").observedAt).toBe(1234);
        } else expect(report.exitCode).toBe(2);
        expect(JSON.stringify(report) + renderDoctor(report)).not.toContain("must-not-appear");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("a hanging check returns an incomplete finding without exposing its cause", async () => {
    const result = await Effect.runPromise(inspectCheck("test", "Try status.", Effect.never));
    expect(result.incomplete).toBe(true);
    expect(result.message).toContain("two seconds");
    expect(doctorReport([result], null).exitCode).toBe(2);
  });

  test("worker collector reads saved failures, holds and uncertain delivery without changing rows", async () => {
    const directory = await fixture();

    const config = Layer.succeed(AppConfig, {
      applicationName: "Test",
      dataDirectory: directory,
      provider: "openrouter",
      model: null,
    });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrate(taskSchema);
          yield* migrate(gatewaySchema);
          yield* sql`INSERT INTO jobs (id,name,prompt,provider,model,schedule,created_at) VALUES ('job','secret-name','secret-prompt','openrouter','model','{}',0)`;
          yield* sql`INSERT INTO job_occurrences (id,job_id,revision,definition,scheduled_at,available_at,status,finished_at) VALUES ('occurrence','job',0,'{}',0,0,'failed',${Date.now()})`;
          yield* sql`INSERT INTO job_provider_pauses VALUES ('openrouter','quota',NULL,1)`;
          yield* sql`INSERT INTO gateway_inbox (id,adapter,account,external_id,payload,run_id,state) VALUES (1,'discord','secret-account','external','secret-payload','run','completed')`;
          yield* sql`INSERT INTO gateway_deliveries (inbox_id,position,text,state) VALUES (1,0,'private message','uncertain')`;
          const before = yield* sql`SELECT * FROM job_occurrences`;
          const snapshot = yield* doctorSnapshot("0".repeat(64));
          expect(snapshot.tasks.failed).toBe(1);
          expect(snapshot.holds).toEqual([
            { provider: "openrouter", reason: "quota", resumeAt: null },
          ]);
          expect(snapshot.delivery.uncertain).toBe(1);
          expect(JSON.stringify(snapshot)).not.toMatch(/secret|private message/);
          expect(yield* sql`SELECT * FROM job_occurrences`).toEqual(before);
        }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(config)))),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
