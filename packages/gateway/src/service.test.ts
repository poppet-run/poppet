import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Agent,
  AgentLive,
  ChatSettings,
  defaultPolicy,
  ModelResolver,
  NotesLive,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import { ProviderError, type ModelOperations, type ModelRequest } from "@poppet/provider";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { ChannelError, MessagingChannel, type IncomingMessage } from "#src/channel";
import { GatewayRepository, GatewayRepositoryLive } from "#src/repository";
import { Gateway, GatewayLive } from "#src/service";

const message = (
  messageId: string,
  conversationId: string | null = null,
  text = "Hello",
): IncomingMessage => ({
  messageId,
  scopeId: "guild",
  parentId: "parent",
  conversationId,
  senderId: "owner",
  text,
  mentioned: conversationId === null,
});

const response = (text = "Answer") =>
  Stream.make({
    type: "completed" as const,
    response: {
      output: [{ type: "text" as const, text }],
      continuation: {
        version: 1 as const,
        provider: "test-provider",
        model: "test-model",
        data: {},
      },
      finishReason: "stop" as const,
      usage: null,
    },
  });

const fixture = async (
  overrides: Partial<MessagingChannel["Service"]> = {},
  stream: ModelOperations["stream"] = () => response(),
) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-gateway-"));
  const requests: ModelRequest[] = [];
  const sent: { destination: string; text: string; nonce: string }[] = [];
  const marks: { messageId: string; state: string }[] = [];

  const channel = Layer.succeed(MessagingChannel, {
    id: "discord",
    accountId: "bot",
    policy: { ownerId: "owner", scopeId: "guild", parentIds: ["parent"] },
    messages: Stream.never,
    conversation: (input) => Effect.succeed(input.conversationId ?? `thread-${input.messageId}`),
    checkAccess: () => Effect.void,
    typing: () => Effect.void,
    mark: (input, state) =>
      Effect.sync(() => {
        marks.push({ messageId: input.messageId, state });
      }),
    send: (destination, text, nonce) =>
      Effect.sync(() => {
        sent.push({ destination, text, nonce });

        return `sent-${sent.length}`;
      }),
    status: Effect.succeed({ connected: true }),
    textLimit: 2000,
    ...overrides,
  });

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const settings = Layer.succeed(ChatSettings, defaultPolicy);

  const agent = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        LocalMemoryLive.pipe(Layer.provide(store)),
        settings,
        NotesLive.pipe(Layer.provide(Layer.merge(config, settings))),
        Layer.succeed(ModelResolver, {
          resolve: (provider, model) => {
            expect([provider, model]).toEqual(["test-provider", "test-model"]);

            return Effect.succeed({
              description: {
                provider,
                id: model,
                name: "Test",
                capabilities: {
                  tools: false,
                  generationSettings: [],
                  contextWindow: null,
                  maxOutputTokens: null,
                },
              },
              stream: (request) => {
                requests.push(request);

                return stream(request);
              },
            });
          },
        }),
      ),
    ),
  );

  const layer = GatewayLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(channel, GatewayRepositoryLive.pipe(Layer.provideMerge(store)), agent),
    ),
  );

  return {
    sent,
    marks,
    requests,
    run: <A, E>(
      program: Effect.Effect<A, E, Gateway | Store | StoreDatabase | GatewayRepository | Agent>,
    ) => Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("messaging gateway", () => {
  test.each(["completed", "failed", "cancelled"] as const)(
    "refreshes typing during work and stops when %s, even after indicator failure",
    async (outcome) => {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const attempts: string[] = [];

      const state = await fixture(
        {
          typing: (destination) =>
            Effect.sync(() => {
              attempts.push(destination);
            }).pipe(
              Effect.andThen(
                Effect.fail(new ChannelError({ reason: "unavailable", message: "Typing failed" })),
              ),
            ),
        },
        () =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(
            Stream.flatMap(() =>
              outcome === "failed"
                ? Stream.fail(
                    new ProviderError({
                      provider: "test-provider",
                      reason: "temporary",
                      message: "Model failed",
                    }),
                  )
                : response(),
            ),
          ),
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.accept(message("first"));
            const running = yield* gateway.processNext.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* TestClock.adjust("0 millis");
            expect(attempts).toEqual(["thread-first"]);
            expect(state.marks).toEqual([{ messageId: "first", state: "working" }]);
            yield* TestClock.adjust("16 seconds");
            expect(attempts).toEqual(["thread-first", "thread-first", "thread-first"]);

            if (outcome === "cancelled")
              yield* gateway.accept(message("cancel", "thread-first", "/cancel"));
            else yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(running);
            expect(state.marks.filter((entry) => entry.messageId === "first")).toEqual([
              { messageId: "first", state: "working" },
              { messageId: "first", state: outcome === "completed" ? "completed" : "stopped" },
            ]);
            yield* TestClock.adjust("16 seconds");
            expect(attempts).toHaveLength(3);
            yield* gateway.deliverNext;
          }),
        );
        expect(state.sent[0]?.text).toBe(
          {
            completed: "Answer",
            cancelled: "Cancelled this thread's queued and active request.",
            failed:
              "The request failed. Use /status in this conversation to inspect its session before sending a new request.",
          }[outcome],
        );
      } finally {
        await state.close();
      }
    },
  );

  test("reaction failures do not fail or repeat model work or reply delivery", async () => {
    const state = await fixture({
      mark: () => Effect.fail(new ChannelError({ reason: "permission", message: "Cannot react" })),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          expect(yield* gateway.status).toMatchObject({ failedRequests: 0, pendingDelivery: 0 });
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(state.sent.map((entry) => entry.text)).toEqual(["Answer"]);
    } finally {
      await state.close();
    }
  });

  test("reports failed inference in the thread without publishing partial text or retrying", async () => {
    const state = await fixture({}, () =>
      Stream.concat(
        Stream.make({ type: "text-delta" as const, text: "Partial private response" }),
        Stream.fail(
          new ProviderError({
            provider: "test-provider",
            reason: "temporary",
            message: "Sensitive provider diagnostic",
          }),
        ),
      ),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          expect(yield* gateway.status).toMatchObject({ failedRequests: 1, executing: 0 });
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(state.sent.map((entry) => entry.text)).toEqual([
        "The request failed. Use /status in this conversation to inspect its session before sending a new request.",
      ]);
    } finally {
      await state.close();
    }
  });

  test("runs receive and delivery loops, and shutdown preserves queued work while interrupting an active run", async () => {
    const incoming = Effect.runSync(Queue.make<IncomingMessage>());
    const delivered = Deferred.makeUnsafe<void>();
    const blocked = Deferred.makeUnsafe<void>();

    const state = await fixture(
      {
        messages: Stream.fromQueue(incoming),
        send: () => Deferred.succeed(delivered, undefined).pipe(Effect.as("sent")),
      },
      (request) => {
        const last = request.messages.at(-1);

        return last?.role === "user" && last.text === "Hold"
          ? Stream.fromEffect(
              Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
            )
          : response();
      },
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* Queue.offer(incoming, message("hold", "thread-first", "Hold"));
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(blocked);
          yield* Deferred.await(delivered);
          yield* Queue.offer(incoming, message("queued", "thread-first", "After shutdown"));
          yield* TestClock.adjust("1 second");
          yield* Fiber.interrupt(worker);
          expect(yield* gateway.status).toMatchObject({ queued: 1, executing: 1 });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.processNext;
          expect(yield* gateway.status).toMatchObject({ queued: 0, executing: 0 });
          const session = (yield* Store).sessions;
          const saved = (yield* session)[0];

          if (saved === undefined) throw new Error("Missing session");
          expect(
            (yield* (yield* Store).runs(saved.id)).filter((run) => run.status === "interrupted"),
          ).toHaveLength(1);
        }),
      );
      expect(state.requests).toHaveLength(3);
    } finally {
      await state.close();
    }
  });

  test("requires mentions only in parent channels, adopts threads, deduplicates and resumes after restart", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;

          for (const input of [
            { ...message("stranger"), senderId: "stranger" },
            { ...message("wrong-guild"), scopeId: "other" },
            { ...message("wrong-parent"), parentId: "other" },
            { ...message("unmentioned"), mentioned: false },
            { ...message("stranger-thread", "existing-thread"), senderId: "stranger" },
            { ...message("wrong-parent-thread", "existing-thread"), parentId: "other" },
          ])
            yield* gateway.accept(input);
          expect(yield* (yield* Store).sessions).toHaveLength(0);
          expect(yield* gateway.status).toMatchObject({ queued: 0 });
          expect(state.marks).toEqual([]);
          yield* gateway.accept(message("first"));
          yield* gateway.accept(message("first"));
          expect(yield* gateway.processNext).toBe(true);
          yield* gateway.accept(message("second", "thread-first", "Continue"));
          yield* gateway.processNext;
          yield* gateway.accept(message("third", "existing-thread"));
          yield* gateway.processNext;
          expect(yield* (yield* Store).sessions).toHaveLength(2);

          while (yield* gateway.deliverNext) {}
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.accept(message("fourth", "thread-first", "After restart"));
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          expect(yield* (yield* Store).sessions).toHaveLength(2);
        }),
      );
      expect(state.requests).toHaveLength(4);
      expect(state.marks.filter((entry) => entry.messageId === "first")).toEqual([
        { messageId: "first", state: "working" },
        { messageId: "first", state: "completed" },
      ]);
      expect(state.requests[0]?.sessionId).toBe(state.requests[3]?.sessionId);
      expect(state.requests[2]?.sessionId).not.toBe(state.requests[0]?.sessionId);
      expect(
        state.requests[3]?.messages
          .filter((entry) => entry.role === "user")
          .map((entry) => entry.text),
      ).toEqual(["Hello", "Continue", "After restart"]);
      expect(state.sent.map((entry) => entry.destination)).toEqual([
        "thread-first",
        "thread-first",
        "existing-thread",
        "thread-first",
      ]);
    } finally {
      await state.close();
    }
  });

  test("recovers queued work and committed answers without replaying interrupted runs", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          yield* (yield* Gateway).accept(message("first"));
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.processNext;
          const { database } = yield* StoreDatabase;
          // Simulate a crash after committing the answer but before recording delivery.
          database.run("DELETE FROM gateway_deliveries");
          database.run("UPDATE gateway_inbox SET state = 'executing'");
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.deliverNext;
          yield* gateway.accept(message("interrupted", "thread-first"));
          const repo = yield* GatewayRepository;
          const pending = repo.next("discord", "bot", Date.now());
          expect(pending).not.toBeNull();

          if (pending === null) return;
          const id = repo.binding("discord", "bot", "guild", "thread-first");

          if (id === null) throw new Error("Missing session");
          repo.attach(pending.id, "thread-first", id);
          repo.state(pending.id, "executing");
          yield* (yield* Store).queueRun(
            id,
            [{ role: "user", text: "Interrupted" }],
            pending.runId,
          );
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          expect(yield* gateway.processNext).toBe(false);
          yield* gateway.deliverNext;
          expect(yield* gateway.status).toMatchObject({ queued: 0, executing: 0 });
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(state.sent.map((entry) => entry.text)).toEqual([
        "Answer",
        "The request failed or was interrupted. Inspect its saved run before sending a new request.",
      ]);
    } finally {
      await state.close();
    }
  });

  test("reconciles uncertain thread creation before running the model", async () => {
    let attempts = 0;

    const state = await fixture({
      conversation: () =>
        ++attempts === 1
          ? Effect.fail(
              new ChannelError({ reason: "uncertain", message: "Lost creation acknowledgement" }),
            )
          : Effect.succeed("recovered-thread"),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          expect(state.requests).toHaveLength(0);
          expect(yield* gateway.processNext).toBe(false);
          yield* TestClock.adjust("1 second");
          yield* gateway.processNext;
          yield* gateway.deliverNext;
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(state.sent[0]?.destination).toBe("recovered-thread");
    } finally {
      await state.close();
    }
  });

  test.each(["unavailable", "permission", "uncertain"] as const)(
    "handles %s delivery without repeating inference",
    async (reason) => {
      let attempts = 0;

      const state = await fixture({
        send: () =>
          ++attempts === 1
            ? Effect.fail(
                new ChannelError({ reason, message: "Injected send failure", retryAfterMs: 60000 }),
              )
            : Effect.succeed("sent"),
      });

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.accept(message("first"));
            yield* gateway.processNext;
            yield* gateway.deliverNext;
            expect(yield* gateway.deliverNext).toBe(false);
            yield* TestClock.adjust("60 seconds");
            expect(yield* gateway.deliverNext).toBe(reason === "unavailable");
            expect(yield* gateway.status).toMatchObject({
              failedDelivery: reason === "permission" ? 1 : 0,
              uncertainDelivery: reason === "uncertain" ? 1 : 0,
            });
          }),
        );
        expect(state.requests).toHaveLength(1);
        expect(attempts).toBe(reason === "unavailable" ? 2 : 1);
      } finally {
        await state.close();
      }
    },
  );

  test("preserves Unicode chunks and stops later chunks after an uncertain send", async () => {
    let attempts = 0;
    const text = "x".repeat(1999) + "😀" + "y".repeat(2200);

    const state = await fixture(
      {
        send: () =>
          ++attempts === 2
            ? Effect.fail(new ChannelError({ reason: "uncertain", message: "Lost reply" }))
            : Effect.succeed("sent"),
      },
      () => response(text),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          const { database } = yield* StoreDatabase;

          const saved = database
            .query<{ text: string }, []>("SELECT text FROM gateway_deliveries ORDER BY position")
            .all();

          expect(saved.map((entry) => entry.text).join("")).toBe(text);
          expect(
            saved.every((entry) => entry.text.length <= 2000 && entry.text.isWellFormed()),
          ).toBe(true);
          yield* gateway.deliverNext;
          yield* gateway.deliverNext;
          expect(yield* gateway.deliverNext).toBe(false);
        }),
      );
      expect(attempts).toBe(2);
    } finally {
      await state.close();
    }
  });

  test("cancels only the thread's active and queued requests while CLI chat can continue", async () => {
    const started = Deferred.makeUnsafe<void>();

    const state = await fixture({}, (request) => {
      const last = request.messages.at(-1);

      return last?.role === "user" && last.text === "Block"
        ? Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        : response();
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;
          yield* gateway.accept(message("block", "thread-first", "Block"));
          const running = yield* gateway.processNext.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* gateway.accept(message("queued", "thread-first", "Queued"));
          yield* gateway.accept({ ...message("other", "other-thread"), mentioned: true });
          yield* gateway.accept(message("cancel", "thread-first", "/cancel"));
          yield* Fiber.join(running);
          yield* gateway.processNext;
          const store = yield* Store;

          const firstSession = (yield* GatewayRepository).binding(
            "discord",
            "bot",
            "guild",
            "thread-first",
          );

          if (firstSession === null) throw new Error("Missing session");
          expect((yield* store.runs(firstSession)).map((run) => run.status).toSorted()).toEqual([
            "completed",
            "interrupted",
          ]);
          yield* Stream.runDrain((yield* Agent).send(firstSession, "CLI follow-up"));
          expect(yield* gateway.status).toMatchObject({ queued: 0, executing: 0 });
        }),
      );
      expect(state.requests).toHaveLength(4);
    } finally {
      await state.close();
    }
  });

  test("bounds pending work and preserves cancellation at capacity", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("first"));
          yield* gateway.processNext;

          for (let index = 0; index < 64; index++)
            yield* gateway.accept(message(`pending-${index}`, "thread-first"));

          const result = yield* gateway
            .accept(message("overflow", "thread-first"))
            .pipe(Effect.result);

          expect(result).toHaveProperty("failure.reason", "overloaded");
          yield* gateway.accept(message("cancel", "thread-first", "/cancel"));
          expect(yield* gateway.status).toMatchObject({ queued: 0 });
          expect(yield* gateway.processNext).toBe(false);
        }),
      );
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });
});
