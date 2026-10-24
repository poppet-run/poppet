import { describe, expect, jest, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ApiKeyStore } from "@poppet/credentials";
import { Clock, ConfigProvider, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

import { type MCPServer } from "#src/config";
import { MCP, makeMCPLive } from "#src/service";

const fixture = async (
  mode = "normal",
  tools = ["read", "write"],
  scheduledTools: string[] = [],
  environment: MCPServer["environment"] = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-mcp-"));

  const server: MCPServer = {
    id: "fixture",
    enabled: true,
    command: process.execPath,
    args: [fileURLToPath(new URL("./test/fixture.ts", import.meta.url)), directory, mode],
    cwd: directory,
    tools,
    scheduledTools,
    environment,
  };

  const layer = makeMCPLive(1024).pipe(
    Layer.provide([
      Layer.succeed(ApiKeyStore, {
        read: () => Effect.succeed(Redacted.make("saved-mcp-secret")),
        write: () => Effect.die("Unexpected credential write"),
        remove: () => Effect.die("Unexpected credential deletion"),
      }),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ mcpServers: JSON.stringify([server]) })),
    ]),
  );

  return {
    directory,
    server,
    layer,
    // The child appends while the test polls, so a read may end mid-line; keep complete lines only.
    events: async () =>
      (await readFile(join(directory, "events"), "utf8"))
        .split("\n")
        .slice(0, -1)
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(line)),
    run: <A, E>(program: Effect.Effect<A, E, MCP>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const dead = (pid: number) => {
  try {
    process.kill(pid, 0);

    return false;
  } catch {
    return true;
  }
};

const expireRequest = async <A>(
  state: Awaited<ReturnType<typeof fixture>>,
  method: string,
  request: () => Promise<A>,
) => {
  const activity = Promise.withResolvers<void>();
  const watcher = watch(state.directory, () => activity.resolve());
  jest.useFakeTimers();

  try {
    let settled = false;

    const result = request().finally(() => {
      settled = true;
      activity.resolve();
    });

    await activity.promise;

    // File IO lets the real subprocess progress while only its timers advance.
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 1000; attempt++) {
          if (settled) break;

          if (!(yield* Effect.promise(() => readdir(state.directory))).includes("events")) continue;
          const events = yield* Effect.promise(() => state.events());

          if (events.some((event) => event.method === method)) jest.advanceTimersToNextTimer();
        }
      }),
    );

    expect(settled).toBe(true);

    return await result;
  } finally {
    watcher.close();
    jest.useRealTimers();
  }
};

// Real time passes for the child process while the test clock controls backoff.
const reaped = (pid: number) =>
  Effect.gen(function* () {
    while (!dead(pid))
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  });

describe("MCP", () => {
  test("when MCP is inspected, discovered, called, and closed, starts lazily, walks pages, validates arguments, and reaps the child", async () => {
    const state = await fixture();
    let pid = 0;

    try {
      await state.run(
        Effect.gen(function* () {
          const mcp = yield* MCP;
          const external = yield* MCP;
          expect((yield* mcp.status)[0]).toMatchObject({ state: "idle", pid: null });
          expect(yield* Effect.promise(() => readdir(state.directory))).toEqual([]);
          expect(yield* external.snapshot(true)).toEqual([]);
          const tools = yield* mcp.tools("fixture");
          expect(tools.map((tool) => tool.toolName)).toEqual(["read", "write"]);
          const catalog = yield* external.snapshot(false);
          const read = catalog[0]!;
          expect(read.definition.parameters).toMatchObject({
            required: ["input"],
            additionalProperties: false,
          });
          expect(
            yield* read.prepare('{"input":"{}"}').pipe(Effect.flatMap((call) => call.execute)),
          ).toContain('"arguments":{}');
          expect(
            yield* read.prepare('{"input":"{\\"text\\":4}"}').pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          expect(
            yield* read.prepare('{"input":"{\\"extra\\":true}"}').pipe(Effect.flip),
          ).toHaveProperty("reason", "tool-arguments");
          pid = (yield* mcp.status)[0]!.pid!;
          expect(dead(pid)).toBe(false);
        }),
      );
      expect(dead(pid)).toBe(true);
      const events = await state.events();
      expect(events.filter((event) => event.method === "tools/list")).toHaveLength(2);
      expect(events.filter((event) => event.method === "tools/call")).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test.each([
    "duplicate",
    "schema",
    "oversized",
    "flood",
    "endless",
    "no-tools",
    "protocol-startup",
  ])(
    "when discovery is %s, rejects it and closes the child without disabling built-ins",
    async (mode) => {
      const state = await fixture(mode);

      try {
        await state.run(
          Effect.gen(function* () {
            expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
            expect((yield* (yield* MCP).status)[0]).toMatchObject({
              state: "unavailable",
              pid: null,
              availableTools: [],
            });

            const pid = Number(
              yield* Effect.promise(() => readFile(join(state.directory, "pid"), "utf8")),
            );

            expect(dead(pid)).toBe(true);
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when scheduled permissions or catalog notifications change, allows only the explicit scheduled subset", async () => {
    const state = await fixture("normal", ["read", "write", "notify"], ["read"]);

    try {
      await state.run(
        Effect.gen(function* () {
          const external = yield* MCP;
          expect((yield* external.snapshot(true)).map((tool) => tool.toolName)).toEqual(["read"]);
          const before = yield* external.snapshot(false);
          const notify = before.find((tool) => tool.toolName === "notify")!;
          yield* notify.prepare('{"input":"{}"}').pipe(Effect.flatMap((call) => call.execute));
          expect((yield* external.snapshot(false)).map((tool) => tool.definition)).toEqual(
            before.map((tool) => tool.definition),
          );
        }),
      );
      expect((await state.events()).filter((event) => event.method === "tools/list")).toHaveLength(
        2,
      );
    } finally {
      await state.close();
    }
  });

  test.each(["error", "disconnect", "invalid-output"])(
    "when a call returns %s, classifies the failure without replay",
    async (name) => {
      const state = await fixture("normal", [name]);

      try {
        await state.run(
          Effect.gen(function* () {
            const tool = (yield* (yield* MCP).snapshot(false))[0]!;
            const call = yield* tool.prepare('{"input":"{}"}');
            const error = yield* call.execute.pipe(Effect.flip);
            expect(error.reason).toBe(name === "error" ? "tool-reported" : "tool-uncertain");
          }),
        );
        expect(
          (await state.events()).filter((event) => event.method === "tools/call"),
        ).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

  test("when cancellation occurs with the owning layer open, waits for child teardown", async () => {
    const state = await fixture("stubborn", ["hang"]);

    try {
      await state.run(
        Effect.gen(function* () {
          const tool = (yield* (yield* MCP).snapshot(false))[0]!;
          const pid = (yield* (yield* MCP).status)[0]!.pid!;
          const call = yield* tool.prepare('{"input":"{}"}');
          const fiber = yield* call.execute.pipe(Effect.forkChild);
          yield* Effect.gen(function* () {
            while (
              !(yield* Effect.promise(state.events)).some((event) => event.method === "tools/call")
            )
              yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            expireRequest(state, "tools/call", () => Effect.runPromise(Fiber.interrupt(fiber))),
          );
          expect(dead(pid)).toBe(true);
          expect((yield* (yield* MCP).status)[0]).toMatchObject({
            state: "unavailable",
            pid: null,
            availableTools: [],
          });
          expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
        }),
      );
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        1,
      );
      expect(
        (await state.events()).filter((event) => event.method === "notifications/cancelled"),
      ).toHaveLength(1);
    } finally {
      await state.close();
    }
  }, 10000);

  test("when an idle protocol failure occurs, reaps the child and rejects retained catalog calls", async () => {
    const state = await fixture("protocol-idle", ["read"]);

    try {
      await state.run(
        Effect.gen(function* () {
          const mcp = yield* MCP;
          const tool = (yield* mcp.snapshot(false))[0]!;
          const call = yield* tool.prepare('{"input":"{}"}');
          const pid = (yield* mcp.status)[0]!.pid!;
          process.kill(pid, "SIGUSR1");
          yield* Effect.gen(function* () {
            while (!dead(pid)) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("2 seconds"));
          expect((yield* mcp.status)[0]).toMatchObject({
            state: "unavailable",
            pid: null,
            availableTools: [],
          });
          expect(yield* call.execute.pipe(Effect.flip)).toHaveProperty("reason", "tool-network");
          expect(yield* mcp.snapshot(false)).toEqual([]);
        }),
      );
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        0,
      );
    } finally {
      await state.close();
    }
  });

  test("when backoff expires after server failure, reconnects on a later request without replaying calls", async () => {
    const state = await fixture("protocol-idle", ["read"]);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* MCP;
          yield* TestClock.setTime(1_000_000);
          expect(yield* mcp.snapshot(false)).toHaveLength(1);
          const first = (yield* mcp.status)[0]!.pid!;

          // A successful reconnect resets the backoff, so each later failure waits 30 seconds.
          for (let attempt = 0; attempt < 2; attempt++) {
            const pid = (yield* mcp.status)[0]!.pid!;
            process.kill(pid, "SIGUSR1");
            yield* reaped(pid);
            const failedAt = yield* Clock.currentTimeMillis;
            expect((yield* mcp.status)[0]).toMatchObject({
              state: "unavailable",
              retryAt: failedAt + 30_000,
            });
            yield* TestClock.adjust(29_999);
            expect(yield* mcp.snapshot(false)).toEqual([]);
            yield* TestClock.adjust(1);
            expect(yield* mcp.snapshot(false)).toHaveLength(1);
            expect((yield* mcp.status)[0]).toMatchObject({ state: "connected", retryAt: null });
            expect((yield* mcp.status)[0]!.pid).not.toBe(first);
          }
        }).pipe(Effect.provide(state.layer), Effect.provide(TestClock.layer())),
      );
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        0,
      );
    } finally {
      await state.close();
    }
  });

  test.each(["", "false"])(
    "when a selected environment value is %j, permits discovery",
    async (value) => {
      const previous = process.env.POPPET_MCP_SELECTED;
      process.env.POPPET_MCP_SELECTED = value;

      const state = await fixture("normal", ["read"], [], {
        SELECTED: { env: "POPPET_MCP_SELECTED" },
      });

      try {
        await state.run(
          Effect.gen(function* () {
            expect((yield* (yield* MCP).snapshot(false)).map((tool) => tool.toolName)).toEqual([
              "read",
            ]);
          }),
        );
        expect((await state.events())[0]!.environment).toMatchObject({ SELECTED: value });
      } finally {
        if (previous === undefined) delete process.env.POPPET_MCP_SELECTED;
        else process.env.POPPET_MCP_SELECTED = previous;
        await state.close();
      }
    },
  );

  test.each(["credential-description", "credential-key"])(
    "when selected secrets appear in %s, rejects discovery",
    async (mode) => {
      const previous = process.env.POPPET_MCP_SELECTED;
      process.env.POPPET_MCP_SELECTED = "selected-mcp-secret";
      const state = await fixture(mode, ["read"], [], { SELECTED: { env: "POPPET_MCP_SELECTED" } });

      try {
        await state.run(
          Effect.gen(function* () {
            expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
            const status = (yield* (yield* MCP).status)[0]!;
            expect(status).toMatchObject({ state: "unavailable", pid: null });
            expect(status.diagnostic).toContain("selected credential");
            expect(JSON.stringify(status)).not.toContain("selected-mcp-secret");
          }),
        );
      } finally {
        if (previous === undefined) delete process.env.POPPET_MCP_SELECTED;
        else process.env.POPPET_MCP_SELECTED = previous;
        await state.close();
      }
    },
  );

  test("when a server receives environment and credentials, passes only selected values and redacts results", async () => {
    const state = await fixture();

    const previous = {
      selected: process.env.POPPET_MCP_SELECTED,
      provider: process.env.POPPET_OPENROUTER_API_KEY,
      channel: process.env.POPPET_DISCORD_TOKEN,
    };

    process.env.POPPET_MCP_SELECTED = "selected-mcp-secret";
    process.env.POPPET_OPENROUTER_API_KEY = "unrelated-provider-secret";
    process.env.POPPET_DISCORD_TOKEN = "unrelated-channel-secret";

    const layer = makeMCPLive(16384).pipe(
      Layer.provide([
        Layer.succeed(ApiKeyStore, {
          read: (name) => {
            expect(name).toBe("mcp-fixture");

            return Effect.succeed(Redacted.make("saved-mcp-secret"));
          },
          write: () => Effect.die("Unexpected write"),
          remove: () => Effect.die("Unexpected delete"),
        }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            mcpServers: JSON.stringify([
              {
                ...state.server,
                environment: {
                  SELECTED: { env: "POPPET_MCP_SELECTED" },
                  SAVED_SECRET: { credential: "mcp-fixture" },
                },
              },
            ]),
          }),
        ),
      ]),
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const tool = (yield* (yield* MCP).snapshot(false))[0]!;

          const result = yield* tool
            .prepare('{"input":"{}"}')
            .pipe(Effect.flatMap((call) => call.execute));

          expect(result).toContain("[REDACTED]");
          expect(result).not.toContain("selected-mcp-secret");
          expect(result).not.toContain("saved-mcp-secret");
          expect(JSON.stringify(yield* (yield* MCP).status)).not.toContain("secret");
        }).pipe(Effect.provide(layer)),
      );
      const start = (await state.events())[0]!;
      expect(start.environment).toMatchObject({
        SELECTED: "selected-mcp-secret",
        SAVED_SECRET: "saved-mcp-secret",
      });
      expect(start.environment).not.toHaveProperty("POPPET_OPENROUTER_API_KEY");
      expect(start.environment).not.toHaveProperty("POPPET_DISCORD_TOKEN");
      expect(start.cwd).toBe(await realpath(state.directory));
    } finally {
      for (const [key, value] of [
        ["POPPET_MCP_SELECTED", previous.selected],
        ["POPPET_OPENROUTER_API_KEY", previous.provider],
        ["POPPET_DISCORD_TOKEN", previous.channel],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }

      await state.close();
    }
  });

  test.each(["huge", "media"])(
    "when results are %s, bounds them without invalid JSON, split Unicode, or automatic resource reads",
    async (name) => {
      const state = await fixture("normal", [name]);

      try {
        await state.run(
          Effect.gen(function* () {
            const tool = (yield* (yield* MCP).snapshot(false))[0]!;

            const result = yield* tool
              .prepare('{"input":"{}"}')
              .pipe(Effect.flatMap((call) => call.execute));

            expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
            expect(result).not.toContain("�");
            expect(JSON.parse(result)).toMatchObject({ truncated: true });

            if (name === "media") {
              expect(JSON.parse(result)).toMatchObject({ omittedContent: 2, content: [] });
              expect(result).not.toContain("secret-media");
            }
          }),
        );
        expect(
          (await state.events()).filter((event) => event.method === "tools/call"),
        ).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

  test("when a dispatched call times out and ignores SIGTERM, reaps it without retry", async () => {
    const state = await fixture("stubborn", ["hang"]);
    let pid = 0;

    try {
      await state.run(
        Effect.gen(function* () {
          const tool = (yield* (yield* MCP).snapshot(false))[0]!;
          pid = (yield* (yield* MCP).status)[0]!.pid!;
          const call = yield* tool.prepare('{"input":"{}"}');

          const error = yield* Effect.promise(() =>
            expireRequest(state, "tools/call", () =>
              Effect.runPromise(call.execute.pipe(Effect.flip)),
            ),
          );

          expect(error.reason).toBe("tool-uncertain");
        }),
      );
      expect(dead(pid)).toBe(true);
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        1,
      );
    } finally {
      await state.close();
    }
  }, 20000);

  test("when startup times out, releases the client and reports an actionable status", async () => {
    const state = await fixture("startup-hang");

    try {
      await expireRequest(state, "initialize", () =>
        state.run(
          Effect.gen(function* () {
            expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
            expect((yield* (yield* MCP).status)[0]).toMatchObject({
              state: "unavailable",
              pid: null,
              diagnostic: expect.stringContaining("retries on a later request"),
            });
          }),
        ),
      );
      expect(dead(Number(await readFile(join(state.directory, "pid"), "utf8")))).toBe(true);
    } finally {
      await state.close();
    }
  }, 10000);
});
