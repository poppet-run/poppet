import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, ChatSettings, defaultPolicy, SkillsLive } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { MCP } from "@poppet/mcp";
import { LocalMemoryLive } from "@poppet/memory";
import { StoreLive } from "@poppet/store";
import { WorkerRequests } from "@poppet/worker";
import { Deferred, Effect, Layer, Stream } from "effect";

import { WorkerRequestsLive } from "#src/commands/worker/requests";

describe("WorkerRequestsLive", () => {
  test("when a client disconnects before pulling the response stream, closes the command scope immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-requests-"));
    const started = Deferred.makeUnsafe<void>();
    const interrupted = Deferred.makeUnsafe<void>();

    const config = Layer.succeed(AppConfig, {
      applicationName: "Test",
      dataDirectory: directory,
      provider: "test-provider",
      model: "test-model",
    });

    const store = StoreLive.pipe(Layer.provideMerge(config));

    const layer = WorkerRequestsLive.pipe(
      Layer.provide([
        config,
        store,
        LocalMemoryLive.pipe(Layer.provide(store)),
        SkillsLive.pipe(Layer.provide(config)),
        Layer.succeed(ChatSettings, defaultPolicy),
        Layer.succeed(MCP, {
          status: Effect.succeed([]),
          snapshot: () => Effect.succeed([]),
          tools: () => Effect.succeed([]),
        }),
        Layer.succeed(Agent, {
          send: () =>
            Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
              ),
            ),
          nameSession: () => Effect.void,
        }),
      ]),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const requests = yield* WorkerRequests;
            const controller = new AbortController();

            const response = yield* requests.handle(
              new Request("http://localhost/v1/commands", {
                method: "POST",
                signal: controller.signal,
              }),
              {
                kind: "chat",
                command: {
                  action: "new",
                  text: "Hello",
                  provider: "test-provider",
                  model: "test-model",
                },
                streamReasoning: true,
              },
            );

            expect(response.status).toBe(200);
            yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
            controller.abort();
            yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"));
          }),
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
