import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, SkillsLive } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { StoreLive } from "@poppet/store";
import { TaskRepositoryLive, remoteTaskCommand } from "@poppet/tasks";
import { WorkerRequests, workerSocketPath } from "@poppet/worker";
import { Console, Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { MessagingWorker } from "#src/channels";
import { workerLaunch } from "#src/worker";
import { runWorker } from "#src/worker-host";

test("builds an absolute launch description that selects the data directory without freezing settings", () => {
  const previous = process.env.POPPET_OPENROUTER_API_KEY;
  const previousSoulBytes = process.env.POPPET_SOUL_BYTES;
  process.env.POPPET_OPENROUTER_API_KEY = "must-not-be-written";
  process.env.POPPET_SOUL_BYTES = "4096";

  try {
    const launch = workerLaunch({
      applicationName: "Test",
      dataDirectory: "/tmp/data",
      notesDirectory: "/tmp/notes",
      provider: "openrouter",
      model: "selected-model",
    });

    expect(launch.executable).toBe(process.execPath);
    expect(launch.arguments).toEqual([
      fileURLToPath(new URL("./worker-background.ts", import.meta.url)),
      "worker",
      "run",
    ]);
    expect(launch.workingDirectory).toBe(process.cwd());
    expect(launch.environment).toEqual(new Map([["POPPET_DATA_DIR", "/tmp/data"]]));
    expect(JSON.stringify(Array.from(launch.environment))).not.toContain("must-not-be-written");
  } finally {
    if (previous === undefined) delete process.env.POPPET_OPENROUTER_API_KEY;
    else process.env.POPPET_OPENROUTER_API_KEY = previous;

    if (previousSoulBytes === undefined) delete process.env.POPPET_SOUL_BYTES;
    else process.env.POPPET_SOUL_BYTES = previousSoulBytes;
  }
});

test.each(["all", "gateway"] as const)(
  "%s worker validates and saves destinations through its task socket",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "p11-worker-"));
    const ready = Deferred.makeUnsafe<void>();

    const destination = {
      adapter: "discord",
      account: "bot",
      ownerId: "owner",
      scopeId: "guild",
      parentId: "parent",
      conversationId: "thread",
    };

    const config = Layer.succeed(AppConfig, {
      applicationName: "Test",
      dataDirectory: directory,
      notesDirectory: join(directory, "notes"),
      provider: "test-provider",
      model: "test-model",
    });

    const store = StoreLive.pipe(Layer.provideMerge(config));

    const services = Layer.mergeAll(
      store,
      SkillsLive.pipe(Layer.provide(config)),
      TaskRepositoryLive.pipe(Layer.provide(store)),
      Layer.succeed(Agent, {
        send: () => Stream.die("Unexpected inference"),
        nameSession: () => Effect.void,
      }),
      Layer.succeed(WorkerRequests, {
        handle: () => Effect.succeed(new Response("Not found", { status: 404 })),
      }),
      Layer.succeed(MessagingWorker, {
        run: Effect.never,
        status: Effect.succeed({}),
        resolveDestination: (adapter, conversationId) => {
          expect([adapter, conversationId]).toEqual(["discord", "thread"]);

          return Effect.succeed(destination);
        },
      }),
    );

    const output: Console.Console = {
      ...console,
      log: (...values) => {
        if (values.join(" ").startsWith("Worker running."))
          Effect.runSync(Deferred.succeed(ready, undefined));
      },
    };

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* runWorker(mode).pipe(Effect.forkScoped);
            yield* Deferred.await(ready);

            const reply = yield* remoteTaskCommand(workerSocketPath(directory), {
              action: "add",
              task: {
                name: "Summary",
                prompt: "Summarize notes",
                provider: "test-provider",
                model: "test-model",
                workload: "assistant",
                schedule: { type: "once", at: Date.parse("2099-10-15T09:00:00Z") },
              },
              delivery: { adapter: "discord", conversationId: "thread" },
            });

            expect(reply?.value).toHaveProperty("destination", destination);
            expect(
              (yield* remoteTaskCommand(workerSocketPath(directory), { action: "list" }))?.value,
            ).toMatchObject([{ destination }]);
            yield* Fiber.interrupt(fiber);
          }),
        ).pipe(Effect.provide(services), Effect.provideService(Console.Console, output)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
