import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ApiKeyStore } from "@poppet/credentials";
import { ConfigProvider, Effect, Fiber, Layer, Redacted, Schema } from "effect";

import { type MCPServer } from "#src/config";
import { MCP, makeMCPLive } from "#src/service";

const fixture = async (
  mode = "normal",
  tools = ["read", "write"],
  scheduledTools: string[] = [],
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
  };

  const layer = makeMCPLive(1024).pipe(
    Layer.provide([
      Layer.succeed(ApiKeyStore, {
        read: () => Effect.succeed(Redacted.make("saved-mcp-secret")),
        write: () => Effect.die("Unexpected credential write"),
        remove: () => Effect.die("Unexpected credential deletion"),
      }),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ POPPET_MCP_SERVERS: JSON.stringify([server]) }),
      ),
    ]),
  );

  return {
    directory,
    server,
    layer,
    events: async () =>
      (await readFile(join(directory, "events"), "utf8"))
        .trim()
        .split("\n")
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

describe("MCP stdio client", () => {
  test("status never launches, discovery walks pages, calls validate original optional fields, and shutdown reaps the child", async () => {
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

  test.each(["duplicate", "schema", "oversized", "flood", "endless", "no-tools"])(
    "rejects %s discovery and closes the child without disabling built-ins",
    async (mode) => {
      const state = await fixture(mode);

      try {
        await state.run(
          Effect.gen(function* () {
            expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
            expect((yield* (yield* MCP).status)[0]).toMatchObject({
              state: "unavailable",
              pid: null,
            });
          }),
        );
        expect(dead(Number(await readFile(join(state.directory, "pid"), "utf8")))).toBe(true);
      } finally {
        await state.close();
      }
    },
  );

  test("scheduled permissions are an explicit subset and catalog notifications never add tools", async () => {
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
    "distinguishes %s without replay",
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

  test("cancellation sends cancellation and closes the child", async () => {
    const state = await fixture("normal", ["hang"]);
    let pid = 0;

    try {
      await state.run(
        Effect.gen(function* () {
          const tool = (yield* (yield* MCP).snapshot(false))[0]!;
          pid = (yield* (yield* MCP).status)[0]!.pid!;
          const call = yield* tool.prepare('{"input":"{}"}');
          const fiber = yield* call.execute.pipe(Effect.forkChild);
          yield* Effect.sleep("50 millis");
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(dead(pid)).toBe(true);
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        1,
      );
    } finally {
      await state.close();
    }
  });
});

test("passes only selected environment and protected credentials and redacts returned values", async () => {
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
          POPPET_MCP_SERVERS: JSON.stringify([
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
  "bounds %s results without invalid JSON, split Unicode or automatic resource reads",
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
      expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(
        1,
      );
    } finally {
      await state.close();
    }
  },
);

test("bounds a dispatched timeout without retry and reaps a SIGTERM-resistant process", async () => {
  const state = await fixture("stubborn", ["hang"]);
  let pid = 0;

  try {
    await state.run(
      Effect.gen(function* () {
        const tool = (yield* (yield* MCP).snapshot(false))[0]!;
        pid = (yield* (yield* MCP).status)[0]!.pid!;

        const error = yield* tool.prepare('{"input":"{}"}').pipe(
          Effect.flatMap((call) => call.execute),
          Effect.flip,
        );

        expect(error.reason).toBe("tool-uncertain");
      }),
    );
    expect(dead(pid)).toBe(true);
    expect((await state.events()).filter((event) => event.method === "tools/call")).toHaveLength(1);
  } finally {
    await state.close();
  }
}, 20000);

test("startup timeout releases the client and leaves an actionable status", async () => {
  const state = await fixture("startup-hang");

  try {
    await state.run(
      Effect.gen(function* () {
        expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
        expect((yield* (yield* MCP).status)[0]).toMatchObject({
          state: "unavailable",
          pid: null,
          diagnostic: expect.stringContaining("Restart"),
        });
      }),
    );
    expect(dead(Number(await readFile(join(state.directory, "pid"), "utf8")))).toBe(true);
  } finally {
    await state.close();
  }
}, 10000);
