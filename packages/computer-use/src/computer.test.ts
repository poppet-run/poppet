import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Fiber } from "effect";

import { computerTools } from "#src/computer";
import { openCalculatorDriver } from "#src/driver";
import { ComputerRuntime } from "#src/runtime";

const fixture = async (mode = "normal") => {
  const root = await mkdtemp(join(tmpdir(), "poppet-computer-"));
  let directory = "";
  let pid = 0;
  let starts = 0;

  const runtime: ComputerRuntime["Service"] = {
    leaseDirectory: join(root, "lease"),
    open: async (_command, path, signal) => {
      directory = path;
      starts++;

      const driver = await openCalculatorDriver(
        process.execPath,
        [fileURLToPath(new URL("./test/observation-fixture.ts", import.meta.url)), path, mode],
        path,
        signal,
      );

      pid = driver.pid;

      if (mode === "slow-startup") await Bun.sleep(100);

      return driver;
    },
  };

  return {
    root,
    runtime,
    starts: () => starts,
    pid: () => pid,
    directory: () => directory,
    tools: (bytes = 16384) =>
      computerTools({ enabled: true, command: "/fixture/cua-driver" }, "run", bytes, {
        pid: 100,
        windowId: 200,
      }),
    run: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(Effect.provideService(ComputerRuntime, runtime)),
    events: async () =>
      (await readFile(`${directory}/events`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    close: () => rm(root, { recursive: true, force: true }),
  };
};

test("a scoped observation exposes one argument-free tool, strips native tokens/geometry, and reaps everything", async () => {
  const state = await fixture();
  let events: Awaited<ReturnType<typeof state.events>> = [];

  try {
    await Effect.runPromise(
      state.run(
        Effect.scoped(
          Effect.gen(function* () {
            const tools = yield* state.tools();
            expect(tools.map((tool) => [tool.serverId, tool.toolName])).toEqual([
              ["computer", "snapshot"],
            ]);
            const first = JSON.parse(yield* (yield* tools[0]!.prepare("{}")).execute);
            const second = JSON.parse(yield* (yield* tools[0]!.prepare("{}")).execute);
            expect(first.elements[0]).toMatchObject({
              role: "AXStaticText",
              label: "Edit field",
              value: "19",
            });
            expect(first.elements[1]).toMatchObject({
              role: "AXButton",
              label: "1",
              actions: ["AXPress"],
            });
            expect(second.snapshotId).not.toBe(first.snapshotId);
            expect(JSON.stringify(first)).not.toContain("element_token");
            expect(JSON.stringify(first)).not.toContain('"frame"');
            events = yield* Effect.promise(state.events);
            expect(events[0].manifest.allow.tools).toEqual([
              "check_permissions",
              "get_window_state",
              "end_session",
            ]);
            expect(events[0].manifest.resources.desktop.display).toBe(false);
            expect(events[0].manifest.resources.apps[0].launch).toBe(false);

            for (const args of [
              "null",
              '{"pid":100}',
              '{"input":"{}"}',
              '{"action":"click"}',
              "x".repeat(65537),
            ])
              expect(yield* tools[0]!.prepare(args).pipe(Effect.flip)).toHaveProperty(
                "reason",
                "tool-arguments",
              );
            events = yield* Effect.promise(state.events);
            expect(events.filter((event) => event.name === "get_window_state")).toHaveLength(2);
            expect(
              events.some((event) =>
                ["click", "launch_app", "list_windows", "screenshot"].includes(event.name),
              ),
            ).toBe(false);
          }),
        ),
      ),
    );
    expect(() => process.kill(state.pid(), 0)).toThrow();
    expect(await Bun.file(`${state.directory()}/manifest.json`).exists()).toBe(false);
    expect(await Bun.file(`${state.root}/lease/owner`).exists()).toBe(false);
  } finally {
    await state.close();
  }
});

test.each(["truncated", "large", "native-default"])(
  "%s observations stay bounded and contain no actionable references",
  async (mode) => {
    const state = await fixture(mode);

    try {
      await Effect.runPromise(
        state.run(
          Effect.scoped(
            Effect.gen(function* () {
              const [tool] = yield* state.tools(1024);
              const result = yield* (yield* tool!.prepare("{}")).execute;
              const data = JSON.parse(result);
              expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
              expect(result).not.toContain("�");
              expect(data.truncated).toBe(true);
              expect(
                data.elements.every((element: { reference: null }) => element.reference === null),
              ).toBe(true);
            }),
          ),
        ),
      );
    } finally {
      await state.close();
    }
  },
);

test.each([
  "input-discovery",
  "permission-denied",
  "screen-recording",
  "wrong-window",
  "screen-locked",
  "media",
  "invalid-output",
  "refusal",
  "disconnect",
  "oversized",
  "stderr",
])("%s stops observation without input or a leaked child", async (mode) => {
  const state = await fixture(mode);

  try {
    const result = await Effect.runPromise(
      state.run(
        Effect.scoped(
          Effect.gen(function* () {
            const [tool] = yield* state.tools();

            return yield* (yield* tool!.prepare("{}")).execute;
          }),
        ).pipe(Effect.flip),
      ),
    );

    expect(result.message).not.toContain("private-fixture");
    expect(() => process.kill(state.pid(), 0)).toThrow();
    expect(await Bun.file(`${state.directory()}/manifest.json`).exists()).toBe(false);
  } finally {
    await state.close();
  }
});

test("cancellation reaps a pending observation and releases the desktop lease", async () => {
  const state = await fixture("hang");

  const fiber = Effect.runFork(
    state.run(
      Effect.scoped(
        Effect.gen(function* () {
          const [tool] = yield* state.tools();

          return yield* (yield* tool!.prepare("{}")).execute;
        }),
      ),
    ),
  );

  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      // The fixture creates its private event file after the driver starts.
      // eslint-disable-next-line no-await-in-loop
      const exists = state.directory() && (await Bun.file(`${state.directory()}/events`).exists());
      // eslint-disable-next-line no-await-in-loop
      const events = exists ? await state.events() : [];

      if (events.some((event) => event.name === "get_window_state")) break;
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(10);
    }

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(() => process.kill(state.pid(), 0)).toThrow();
    expect(await Bun.file(`${state.root}/lease/owner`).exists()).toBe(false);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await state.close();
  }
});

test("cancellation during driver acquisition still reaps the acquired child", async () => {
  const state = await fixture("slow-startup");
  const fiber = Effect.runFork(state.run(Effect.scoped(state.tools())));

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        while (state.pid() === 0) yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("2 seconds")),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(() => process.kill(state.pid(), 0)).toThrow();
    expect(await Bun.file(`${state.directory()}/manifest.json`).exists()).toBe(false);
    expect(await Bun.file(`${state.root}/lease/owner`).exists()).toBe(false);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
    await state.close();
  }
});

test("contending runs fail busy before a second driver starts", async () => {
  const state = await fixture();

  try {
    await Effect.runPromise(
      state.run(
        Effect.scoped(
          Effect.gen(function* () {
            yield* state.tools();
            const error = yield* Effect.scoped(state.tools()).pipe(Effect.flip);
            expect(error).toHaveProperty("reason", "tool-permission");
            expect(state.starts()).toBe(1);
          }),
        ),
      ),
    );
  } finally {
    await state.close();
  }
});
