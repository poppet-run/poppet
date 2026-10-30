import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, SkillsLive } from "@poppet/agent";
import { AppConfig, ConfigIdentity } from "@poppet/config";
import { gatewaySchema } from "@poppet/gateway";
import { StoreLive, migrate } from "@poppet/store";
import { TaskRepositoryLive, remoteTaskCommand } from "@poppet/tasks";
import { WorkerRequests, workerSocketPath, requestWorker } from "@poppet/worker";
import { Console, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";

import { MessagingWorker } from "#src/commands/gateway/channels";
import { runWorker } from "#src/commands/worker/host";
import { workerLaunch } from "#src/commands/worker/service";

describe("workerLaunch", () => {
  test("when installing a worker, includes the data directory without shell secrets or setting overrides", () => {
    const previous = process.env.POPPET_OPENROUTER_API_KEY;
    const previousSoulBytes = process.env.POPPET_SOUL_BYTES;
    process.env.POPPET_OPENROUTER_API_KEY = "must-not-be-written";
    process.env.POPPET_SOUL_BYTES = "4096";

    try {
      const launch = workerLaunch("/tmp/data");

      expect(launch.environment).toEqual(new Map([["POPPET_DATA_DIR", "/tmp/data"]]));
    } finally {
      if (previous === undefined) delete process.env.POPPET_OPENROUTER_API_KEY;
      else process.env.POPPET_OPENROUTER_API_KEY = previous;

      if (previousSoulBytes === undefined) delete process.env.POPPET_SOUL_BYTES;
      else process.env.POPPET_SOUL_BYTES = previousSoulBytes;
    }
  });
});

describe("runWorker", () => {
  test("when the worker receives a task destination, validates and saves it through the socket", async () => {
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
      provider: "test-provider",
      model: "test-model",
    });

    const store = StoreLive.pipe(Layer.provideMerge(config));

    const services = Layer.mergeAll(
      store,
      Layer.succeed(ConfigIdentity, "0".repeat(64)),
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
            yield* migrate(gatewaySchema);
            const fiber = yield* runWorker.pipe(Effect.forkScoped);
            yield* Deferred.await(ready);

            const reply = yield* remoteTaskCommand(workerSocketPath(directory), {
              action: "add",
              task: {
                name: "Summary",
                prompt: "Summarize recent conversations",
                provider: "test-provider",
                model: "test-model",
                schedule: { type: "once", at: Date.parse("2099-10-15T09:00:00Z") },
              },
              delivery: { adapter: "discord", conversationId: "thread" },
            });

            expect(reply?.value).toHaveProperty("destination", destination);
            expect(
              (yield* remoteTaskCommand(workerSocketPath(directory), { action: "list" }))?.value,
            ).toMatchObject([{ destination }]);
            const sql = yield* SqlClient.SqlClient;
            const before = yield* sql`SELECT * FROM job_occurrences`;

            const observation = yield* Effect.tryPromise(async (signal) => {
              const response = await requestWorker(
                workerSocketPath(directory),
                "/v1/doctor",
                { version: 1 },
                signal,
              );

              expect(response?.status).toBe(200);

              return response?.json();
            });

            expect(observation).toMatchObject({
              version: 1,
              identity: "0".repeat(64),
              tasks: { failed: 0 },
              gateway: { unknown: 1 },
            });
            expect(yield* sql`SELECT * FROM job_occurrences`).toEqual(before);
            yield* Fiber.interrupt(fiber);
          }),
        ).pipe(Effect.provide(services), Effect.provideService(Console.Console, output)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
