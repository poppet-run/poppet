import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { StoreLive } from "@poppet/store";
import { TaskDestinations, TaskError, TaskRepository, TaskRepositoryLive } from "@poppet/tasks";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { serveWebhooks, webhookHandler } from "#src/webhooks";

const secret = "a".repeat(32);

const request = (body = '{"event":"failed"}', headers: Record<string, string> = {}) =>
  new Request("http://localhost/v1/hooks/deploy", {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "idempotency-key": "event-1",
      ...headers,
    },
  });

test("webhook HTTP validation never queues unauthorized, malformed, or oversized events", async () => {
  let accepted = 0;

  const handler = webhookHandler(
    new Map([
      [
        "/v1/hooks/deploy",
        {
          secret,
          accept: async () => {
            accepted++;

            return { status: "accepted" as const, taskId: "task" };
          },
        },
      ],
    ]),
  );

  expect((await handler(request("{}", { authorization: "Bearer wrong" }))).status).toBe(401);
  expect((await handler(request("{}", { "idempotency-key": "" }))).status).toBe(400);
  expect((await handler(request("{}", { "content-type": "text/plain" }))).status).toBe(415);

  await Promise.all(
    ["null", "[]", "{", "1"].map(async (value) => {
      expect((await handler(request(value))).status).toBe(400);
    }),
  );
  const oversized = await handler(request(JSON.stringify({ text: "x".repeat(6144) })));
  expect(oversized.status).toBe(413);
  const missingMethod = await handler(new Request("http://localhost/v1/hooks/deploy"));
  expect(missingMethod.status).toBe(404);
  expect(accepted).toBe(0);
  expect((await handler(request())).status).toBe(202);
  expect(accepted).toBe(1);
});

test("webhook acknowledgments wait for durable acceptance and preserve event identity", async () => {
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let settled = false;

  const handler = webhookHandler(
    new Map([
      [
        "/v1/hooks/deploy",
        {
          secret,
          accept: async (id, digest, payload) => {
            expect(id).toBe("event-1");
            expect(digest).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.parse(payload)).toEqual({ event: "failed" });
            await gate;

            return { status: "accepted" as const, taskId: "task" };
          },
        },
      ],
    ]),
  );

  const response = handler(request()).then((value) => {
    settled = true;

    return value;
  });

  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await (await response).json()).toEqual({ status: "accepted", taskId: "task" });
});

test.each([
  ["duplicate", 202],
  ["conflict", 409],
  ["full", 429],
  ["failure", 503],
] as const)("webhook %s returns HTTP %i", async (status, expected) => {
  const handler = webhookHandler(
    new Map([
      [
        "/v1/hooks/deploy",
        {
          secret,
          accept: async () => {
            if (status === "failure") throw new Error("private storage details");

            return { status, taskId: null };
          },
        },
      ],
    ]),
  );

  const response = await handler(request());
  expect(response.status).toBe(expected);
  expect(await response.text()).not.toContain("private storage details");
});

test("worker-scoped listener queues concurrent deliveries once and closes on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-webhooks-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);

  const configuration = {
    port,
    hooks: [
      {
        id: "deploy",
        secretFile: "hook-secret",
        prompt: "Summarize this event.",
        provider: "test-provider",
        model: "test-model",
      },
    ],
  };

  const configuredHooks = {
    ...configuration,
    hooks: [
      ...configuration.hooks,
      {
        ...configuration.hooks[0]!,
        id: "offline",
        delivery: { adapter: "discord", conversationId: null },
      },
    ],
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provide(config));
  const repository = TaskRepositoryLive.pipe(Layer.provide(store));

  try {
    await writeFile(join(directory, "hook-secret"), secret, { mode: 0o600 });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* serveWebhooks;
          yield* Effect.promise(async () => {
            const headers = request().headers;

            const oversized = await fetch(`http://127.0.0.1:${port}/v1/hooks/deploy`, {
              method: "POST",
              headers,
              body: JSON.stringify({ text: "x".repeat(7000) }),
            });

            expect(oversized.status).toBe(413);

            const unavailable = await fetch(`http://127.0.0.1:${port}/v1/hooks/offline`, {
              method: "POST",
              headers,
              body: "{}",
            });

            expect(unavailable.status).toBe(503);
          });

          const receipts = yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: 4 }, async () => {
                const input = request();

                const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/deploy`, {
                  method: "POST",
                  headers: input.headers,
                  body: await input.text(),
                });

                expect(response.status).toBe(202);

                return Schema.decodeUnknownSync(
                  Schema.Struct({ status: Schema.String, taskId: Schema.String }),
                )(await response.json());
              }),
            ),
          );

          expect(receipts.filter((receipt) => receipt.status === "accepted")).toHaveLength(1);
          expect(new Set(receipts.map((receipt) => receipt.taskId)).size).toBe(1);
          const repo = yield* TaskRepository;
          expect(yield* repo.list()).toHaveLength(1);
          const queued = (yield* repo.claim(Date.now()))!;
          expect(queued.definition.source).toBe("webhook");
          expect(queued.definition.prompt).toContain('"event":"failed"');
        }),
      ).pipe(
        Effect.provide(Layer.merge(config, repository)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ webhooks: JSON.stringify(configuredHooks) }),
        ),
        Effect.provideService(TaskDestinations, {
          resolve: () => Effect.fail(new TaskError({ message: "Gateway is connecting" })),
        }),
      ),
    );
    // Rebinding proves scoped shutdown released the listening socket.
    const reopened = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    await reopened.stop(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
