import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent } from "@poppet/agent";
import { ComputerRuntime, openCalculatorDriver } from "@poppet/computer-use/runtime";
import {
  Provider,
  ProviderConnection,
  type ModelRequest,
  type ProviderRegistration,
  type Output,
} from "@poppet/provider";
import { Store } from "@poppet/store";
import { requestWorker, workerSocketPath } from "@poppet/worker";
import { Console, Effect, Fiber, Layer, Schema, Stream } from "effect";

import { makeCLI } from "#src/cli";
import { runtimeLayers } from "#src/runtime";

const fixture = async (mode = "normal") => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-computer-cli-"));
  const previous = process.env.POPPET_DATA_DIR;
  process.env.POPPET_DATA_DIR = directory;

  const settings = {
    provider: "fixture",
    model: "fixture",
    computer: { enabled: true, command: "/fixture/cua-driver" },
  };

  await writeFile(join(directory, "config.json"), JSON.stringify(settings));
  let starts = 0;
  let pid = 0;
  let calls: Array<{ tool: string; outcome: string }> = [];
  const requests: ModelRequest[] = [];
  const lines: string[] = [];

  const registration: ProviderRegistration = {
    id: "fixture",
    name: "Fixture",
    authentication: { apiKey: false, consent: false, help: "Test" },
    layer: Layer.merge(
      Layer.succeed(ProviderConnection, {
        login: () => Effect.succeed("Connected"),
        status: Effect.succeed({ connected: true }),
        logout: Effect.succeed("Disconnected"),
        verify: () => Effect.succeed("fixture"),
      }),
      Layer.succeed(Provider, {
        id: "fixture",
        models: Effect.succeed([]),
        resolve: () =>
          Effect.succeed({
            description: {
              provider: "fixture",
              id: "fixture",
              name: "Fixture",
              capabilities: {
                tools: true,
                generationSettings: [],
                contextWindow: null,
                maxOutputTokens: null,
              },
            },
            stream: (request) => {
              requests.push(request);
              const after = request.messages.some((message) => message.role === "tool");
              const computer = request.tools.some((tool) => tool.namespace === "poppet_computer");

              let output: ReadonlyArray<Output> = [
                { type: "text", text: after ? "Calculator reports 19" : "Ordinary chat" },
              ];

              if (computer && !after)
                output = [
                  {
                    type: "tool-call",
                    callId: "observe",
                    name: "snapshot",
                    namespace: "poppet_computer",
                    arguments: mode === "arguments" ? '{"pid":100}' : "{}",
                  },
                ];

              if (after && mode === "injection")
                output = [
                  {
                    type: "tool-call",
                    callId: "injected",
                    name: "save_note",
                    namespace: "poppet_notes",
                    arguments: '{"path":"injected.md","content":"injected"}',
                  },
                ];

              if (after && mode === "press")
                output = [
                  {
                    type: "tool-call",
                    callId: "press",
                    name: "press",
                    namespace: "poppet_computer",
                    arguments: '{"reference":"e1"}',
                  },
                ];

              return Stream.make({
                type: "completed" as const,
                response: {
                  output,
                  continuation: {
                    version: 1 as const,
                    provider: "fixture",
                    model: "fixture",
                    data: {},
                  },
                  finishReason: output.some((part) => part.type === "tool-call")
                    ? ("tool-calls" as const)
                    : ("stop" as const),
                  usage: null,
                },
              });
            },
          }),
      }),
    ),
  };

  const host: ComputerRuntime["Service"] = {
    leaseDirectory: join(directory, "desktop-lease"),
    open: async (_command, path, signal) => {
      starts++;

      const driver = await openCalculatorDriver(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../packages/computer-use/src/test/observation-fixture.ts",
              import.meta.url,
            ),
          ),
          path,
          mode,
        ],
        path,
        signal,
      );

      pid = driver.pid;

      return {
        ...driver,
        close: async () => {
          await driver.close();
          calls = [...driver.calls];
        },
      };
    },
  };

  const output: Console.Console = {
    ...console,
    log: (...values) => lines.push(values.join(" ")),
    error: (...values) => lines.push(values.join(" ")),
  };

  const run = makeCLI(
    [registration],
    (text) =>
      Effect.sync(() => {
        lines.push(text);
      }),
    undefined,
    [],
  );

  const program = (args: ReadonlyArray<string>) =>
    run(args).pipe(
      Effect.provideService(ComputerRuntime, host),
      Effect.provideService(Console.Console, output),
    );

  const runtime = runtimeLayers([registration]);

  return {
    directory,
    settings,
    requests,
    program,
    runtime,
    starts: () => starts,
    calls: () => calls,
    pid: () => pid,
    config: (extra: Schema.JsonObject) =>
      writeFile(join(directory, "config.json"), JSON.stringify({ ...settings, ...extra })),
    invoke: async (args: ReadonlyArray<string>) => {
      lines.length = 0;
      await Effect.runPromise(program(args));

      return lines.join("\n");
    },
    worker: async () => {
      const fiber = Effect.runFork(program(["tasks", "work"]));
      await Effect.runPromise(
        Effect.gen(function* () {
          while (!lines.some((line) => line.includes("Worker running.")))
            yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds")),
      );

      return fiber;
    },
    close: async () => {
      if (previous === undefined) delete process.env.POPPET_DATA_DIR;
      else process.env.POPPET_DATA_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const trial = [
  "chat",
  "new",
  "--computer",
  "--computer-target",
  "100:200",
  "Identify the display and arithmetic buttons",
];

test("fresh local opt-in offers only snapshot, saves normalized observations, and does not persist the permit", async () => {
  const state = await fixture();

  try {
    expect(await state.invoke(trial)).toContain("Calculator reports 19");
    expect(state.requests[0]!.tools.map((tool) => [tool.namespace, tool.name])).toEqual([
      ["poppet_computer", "snapshot"],
    ]);
    expect(state.calls().map((call) => call.tool)).toEqual([
      "check_permissions",
      "check_permissions",
      "get_window_state",
      "end_session",
    ]);
    expect(() => process.kill(state.pid(), 0)).toThrow();
    const sessions = JSON.parse(await state.invoke(["chat", "sessions"]));
    const saved = JSON.parse(await state.invoke(["chat", "show", sessions[0].id]));
    expect(saved.toolCalls[0]).toMatchObject({
      serverId: "computer",
      toolName: "snapshot",
      status: "completed",
    });
    expect(saved.toolCalls[0].output).toContain('"value":"19"');
    expect(JSON.stringify(saved)).not.toContain("element_token");
    expect(saved.session.computer).toBeUndefined();
    await state.invoke(["chat", "send", sessions[0].id, "Look again"]);
    expect(state.starts()).toBe(1);
    expect(
      state.requests
        .filter((request) => request.settings.toolChoice === "none")
        .every((request) => request.tools.length === 0),
    ).toBe(true);
  } finally {
    await state.close();
  }
});

test.each(["normal", "literal"])(
  "ordinary %s chat cannot opt in through its text",
  async (mode) => {
    const state = await fixture();

    try {
      await state.invoke([
        "chat",
        "new",
        mode === "literal"
          ? "Please use --computer --computer-target 100:200"
          : "Look at Calculator",
      ]);
      expect(state.starts()).toBe(0);
      expect(state.requests[0]!.tools.some((tool) => tool.namespace === "poppet_computer")).toBe(
        false,
      );
    } finally {
      await state.close();
    }
  },
);

test.each(["arguments", "injection", "press"])(
  "%s cannot widen the observation-only trial",
  async (mode) => {
    const state = await fixture(mode);

    try {
      await expect(state.invoke(trial)).rejects.toHaveProperty(
        "reason",
        mode === "arguments" ? "tool-arguments" : "tool-permission",
      );
      expect(
        state
          .calls()
          .some((call) => ["click", "press", "launch_app", "screenshot"].includes(call.tool)),
      ).toBe(false);
      expect(await Bun.file(join(state.directory, "notes/injected.md")).exists()).toBe(false);
      expect(() => process.kill(state.pid(), 0)).toThrow();
    } finally {
      await state.close();
    }
  },
);

test("configuration inspection is pure and mixed trial data fails before driver startup", async () => {
  const state = await fixture();

  try {
    expect(JSON.parse(await state.invoke(["config"])).computer).toEqual(state.settings.computer);
    expect(state.starts()).toBe(0);
    await writeFile(join(state.directory, "profile.md"), "private-profile");
    await expect(state.invoke(trial)).rejects.toHaveProperty("reason", "tool-permission");
    expect(state.starts()).toBe(0);
    expect(state.requests).toHaveLength(0);
  } finally {
    await state.close();
  }
});

test("a disconnected observation stays uncertain after reopening storage and is never replayed", async () => {
  const state = await fixture("disconnect");

  try {
    await expect(state.invoke(trial)).rejects.toHaveProperty("reason", "tool-uncertain");
    const sessions = JSON.parse(await state.invoke(["chat", "sessions"]));
    const saved = JSON.parse(await state.invoke(["chat", "show", sessions[0].id]));
    expect(saved.toolCalls[0]).toMatchObject({
      serverId: "computer",
      toolName: "snapshot",
      status: "uncertain",
    });
    expect(state.calls().filter((call) => call.tool === "get_window_state")).toHaveLength(1);
    await state.invoke(["chat", "send", sessions[0].id, "Continue without computer access"]);
    expect(state.starts()).toBe(1);
    expect(() => process.kill(state.pid(), 0)).toThrow();
  } finally {
    await state.close();
  }
});

test.each(["disabled", "missing-target", "orphan-target", "malformed-target", "coding"])(
  "%s trial requests stop before inference or driver startup",
  async (mode) => {
    const state = await fixture();

    try {
      if (mode === "disabled") await state.config({ computer: { enabled: false } });
      let args = trial;

      if (mode === "missing-target") args = ["chat", "new", "--computer", "Observe"];
      else if (mode === "orphan-target")
        args = ["chat", "new", "--computer-target", "100:200", "Observe"];
      else if (mode === "malformed-target")
        args = ["chat", "new", "--computer", "--computer-target", "100:0", "Observe"];
      else if (mode === "coding")
        args = ["chat", "new", "--coding", "--computer", "--computer-target", "100:200", "Observe"];
      await expect(state.invoke(args)).rejects.toBeDefined();
      expect(state.starts()).toBe(0);
      expect(state.requests).toHaveLength(0);
    } finally {
      await state.close();
    }
  },
);

test.each(["mcp", "notes", "channels"])(
  "configured %s is rejected before computer startup",
  async (mode) => {
    const state = await fixture();

    try {
      if (mode === "mcp")
        await state.config({
          mcpServers: [
            {
              id: "other",
              enabled: true,
              command: "/must-not-start",
              args: [],
              tools: ["read"],
              scheduledTools: [],
            },
          ],
        });
      else {
        await mkdir(join(state.directory, mode));
        await writeFile(join(state.directory, mode, "private.txt"), "private");
      }

      await expect(state.invoke(trial)).rejects.toHaveProperty("reason", "tool-permission");
      expect(state.starts()).toBe(0);
      expect(state.requests).toHaveLength(0);
    } finally {
      await state.close();
    }
  },
);

test("a worker rejects computer trials and forged permits while ordinary worker chat stays available", async () => {
  const state = await fixture();
  const worker = await state.worker();

  try {
    await expect(state.invoke(trial)).rejects.toHaveProperty("reason", "tool-permission");

    const reply = await requestWorker(
      workerSocketPath(state.directory),
      "/commands",
      {
        kind: "chat",
        command: {
          action: "new",
          text: "Observe",
          provider: "fixture",
          model: "fixture",
          workload: "assistant",
          computer: true,
        },
      },
      new AbortController().signal,
    );

    expect(reply?.status).toBe(400);
    await reply?.body?.cancel();
    expect(JSON.parse(await state.invoke(["chat", "sessions"]))).toHaveLength(0);
    await state.invoke(["chat", "new", "Ordinary worker chat"]);
    expect(state.starts()).toBe(0);
  } finally {
    await Effect.runPromise(Fiber.interrupt(worker));
    await state.close();
  }
});

test("resumed and scheduled permits fail at the agent boundary before any driver starts", async () => {
  const state = await fixture();

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const agent = yield* Agent;
        const session = yield* store.createSession("fixture", "fixture");
        yield* agent.send(session.id, "Hello").pipe(Stream.runDrain);
        expect(
          yield* agent
            .send(session.id, "Observe", { computer: true })
            .pipe(Stream.runDrain, Effect.flip),
        ).toHaveProperty("reason", "invalid-request");
        const fresh = yield* store.createSession("fixture", "fixture");
        expect(
          yield* agent
            .send(fresh.id, "Observe", { computer: true, readOnlyTools: true })
            .pipe(Stream.runDrain, Effect.flip),
        ).toHaveProperty("reason", "invalid-request");
      }).pipe(Effect.provide(state.runtime.chat)),
    );
    expect(state.starts()).toBe(0);
  } finally {
    await state.close();
  }
});
