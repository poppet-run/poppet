import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import {
  ProviderError,
  type Completion,
  type ModelEvent,
  type ModelOperations,
  type ModelRequest,
} from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AgentError } from "#src/errors";
import { Agent, AgentLive, ModelResolver, type ChatEvent } from "#src/service";
import { ChatSettings, defaultPolicy } from "#src/settings";

const response = (text = "Hello"): Completion => ({
  output: [{ type: "text", text }],
  continuation: {
    version: 1,
    provider: "test-provider",
    model: "test-model",
    data: { opaque: ["preserve", { signature: "value" }] },
  },
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 2 },
});

const description: ModelOperations["description"] = {
  provider: "test-provider",
  id: "test-model",
  name: "Test model",
  capabilities: {
    tools: true,
    generationSettings: ["maxOutputTokens"],
    contextWindow: null,
    maxOutputTokens: 1000,
  },
};

const fixture = async (resolve: ModelResolver["Service"]["resolve"]) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-agent-"));

  const store = StoreLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "test-provider",
        model: "test-model",
      }),
    ),
  );

  const layer = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        Layer.succeed(ModelResolver, { resolve }),
        Layer.succeed(ChatSettings, defaultPolicy),
      ),
    ),
  );

  return {
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const failure = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));

describe("persisted agent", () => {
  test("streams and resumes after reopening with pinned identity, workload and opaque continuation", async () => {
    const requests: ModelRequest[] = [];
    const events: ChatEvent[] = [];

    const model: ModelOperations = {
      description,
      stream: (request) => {
        requests.push(request);

        return Stream.make<ModelEvent[]>(
          { type: "text-delta", text: "Hel" },
          { type: "completed", response: response() },
        );
      },
    };

    const state = await fixture((provider, id) => {
      expect([provider, id]).toEqual(["test-provider", "test-model"]);

      return Effect.succeed(model);
    });

    try {
      const savedSession = await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model", "coding");
          yield* Stream.runForEach((yield* Agent).send(session.id, "First"), (event) =>
            Effect.sync(() => events.push(event)),
          );
          expect((yield* store.runs(session.id))[0]).toMatchObject({
            status: "completed",
            workload: "coding",
            result: response(),
          });

          return session;
        }),
      );

      await state.run(
        Effect.gen(function* () {
          yield* Stream.runDrain((yield* Agent).send(savedSession.id, "Second"));
          const store = yield* Store;
          expect((yield* store.messages(savedSession.id)).map((entry) => entry.message)).toEqual([
            { role: "user", text: "First" },
            { role: "assistant", output: response().output, continuation: response().continuation },
            { role: "user", text: "Second" },
            { role: "assistant", output: response().output, continuation: response().continuation },
          ]);
        }),
      );
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "text-delta",
        "text-delta",
        "completed",
      ]);
      expect(
        events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join(""),
      ).toBe("Hello");
      expect(requests[1]).toMatchObject({
        sessionId: savedSession.id,
        workload: "coding",
        tools: [],
        settings: { maxOutputTokens: 1000 },
        messages: [
          { role: "user", text: "First" },
          { role: "assistant", output: response().output, continuation: response().continuation },
          { role: "user", text: "Second" },
        ],
      });
    } finally {
      await state.close();
    }
  });

  test.each([
    "authentication",
    "permission",
    "quota",
    "rate-limit",
    "temporary",
    "context-limit",
    "interrupted",
  ] as const)(
    "persists provider %s failures without retry, partial answers or failed input in subsequent context",
    async (reason) => {
      let calls = 0;
      const requests: ModelRequest[] = [];

      const model: ModelOperations = {
        description,
        stream: (request) => {
          requests.push(request);
          calls++;

          return calls === 1
            ? Stream.concat(
                Stream.make({ type: "text-delta" as const, text: "Partial" }),
                Stream.fail(
                  new ProviderError({
                    provider: "test-provider",
                    reason,
                    message: "Provider failed",
                  }),
                ),
              )
            : Stream.make({ type: "completed", response: response() });
        },
      };

      const state = await fixture(() => Effect.succeed(model));

      try {
        await state.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const agent = yield* Agent;
            const session = yield* store.createSession("test-provider", "test-model");
            expect(
              yield* failure(Stream.runDrain(agent.send(session.id, "Failed input"))),
            ).toMatchObject({ reason });
            expect(calls).toBe(1);
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: reason === "interrupted" ? "interrupted" : "failed",
              failureReason: `provider:${reason}`,
              result: null,
            });
            expect((yield* store.messages(session.id)).map((entry) => entry.message)).toEqual([
              { role: "user", text: "Failed input" },
            ]);
            yield* Stream.runDrain(agent.send(session.id, "Retry explicitly"));
            expect(requests[1]?.messages).toEqual([{ role: "user", text: "Retry explicitly" }]);
            expect(yield* store.runs(session.id)).toContainEqual(
              expect.objectContaining({ status: "completed" }),
            );
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("records resolution failures after persisting the input", async () => {
    const state = await fixture(() =>
      Effect.fail(
        new ProviderError({
          provider: "test-provider",
          reason: "authentication",
          message: "Reconnect",
        }),
      ),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          expect(
            yield* failure(Stream.runDrain((yield* Agent).send(session.id, "Hello"))),
          ).toMatchObject({ reason: "authentication" });
          expect((yield* store.runs(session.id))[0]).toMatchObject({
            status: "failed",
            failureReason: "provider:authentication",
          });
          expect((yield* store.messages(session.id)).length).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects oversized input and mismatched model selection without calling inference", async () => {
    let calls = 0;
    let wrongModel = false;

    const state = await fixture(() =>
      Effect.succeed({
        description: wrongModel ? { ...description, id: "different-model" } : description,
        stream: () => {
          calls++;

          return Stream.make({ type: "completed", response: response() });
        },
      }),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession("test-provider", "test-model");
          expect(
            yield* failure(Stream.runDrain(agent.send(session.id, "x".repeat(65536)))),
          ).toMatchObject({ reason: "context-limit" });
          expect((yield* store.runs(session.id))[0]).toMatchObject({
            status: "failed",
            failureReason: "agent:context-limit",
          });
          wrongModel = true;
          expect(yield* failure(Stream.runDrain(agent.send(session.id, "Hello")))).toMatchObject({
            reason: "invalid-request",
          });
          expect(yield* store.runs(session.id)).toContainEqual(
            expect.objectContaining({ status: "failed", failureReason: "agent:invalid-request" }),
          );
          expect(calls).toBe(0);
          expect((yield* store.messages(session.id)).length).toBe(2);
        }),
      );
    } finally {
      await state.close();
    }
  });

  const completionCases: Array<{
    readonly name: string;
    readonly events: ReadonlyArray<ModelEvent>;
    readonly reason: AgentError["reason"];
  }> = [
    { name: "missing", events: [], reason: "protocol" },
    {
      name: "duplicate",
      events: [
        { type: "completed", response: response() },
        { type: "completed", response: response() },
      ],
      reason: "protocol",
    },
    {
      name: "trailing",
      events: [
        { type: "completed", response: response() },
        { type: "text-delta", text: "extra" },
      ],
      reason: "protocol",
    },
    {
      name: "mismatch",
      events: [
        { type: "text-delta", text: "Different" },
        { type: "completed", response: response() },
      ],
      reason: "protocol",
    },
    {
      name: "foreign",
      events: [
        {
          type: "completed",
          response: {
            ...response(),
            continuation: { ...response().continuation, provider: "foreign-provider" },
          },
        },
      ],
      reason: "protocol",
    },
    {
      name: "tool",
      events: [
        {
          type: "completed",
          response: {
            ...response(),
            output: [
              {
                type: "tool-call",
                callId: "call",
                namespace: "notes",
                name: "read_note",
                arguments: "{}",
              },
            ],
            finishReason: "tool-calls",
          },
        },
      ],
      reason: "tools-unavailable",
    },
    {
      name: "oversize",
      events: [{ type: "completed", response: response("x".repeat(131073)) }],
      reason: "output-limit",
    },
  ];

  test.each(completionCases)("does not commit a $name completion", async ({ events, reason }) => {
    const state = await fixture(() =>
      Effect.succeed({ description, stream: () => Stream.fromIterable(events) }),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          expect(
            yield* failure(Stream.runDrain((yield* Agent).send(session.id, "Hello"))),
          ).toMatchObject({
            reason,
          });
          expect((yield* store.runs(session.id))[0]).toMatchObject({
            status: "failed",
            result: null,
          });
          expect((yield* store.messages(session.id)).length).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("early consumption and cancellation release the active run for the next request", async () => {
    let resolved = 0;
    const ready = Promise.withResolvers<void>();

    const state = await fixture(() => {
      resolved++;

      return Effect.succeed({
        description,
        stream: () =>
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                ready.resolve();

                return { type: "text-delta" as const, text: "Partial" };
              }),
            ),
            Stream.never,
          ),
      });
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession("test-provider", "test-model");
          yield* Stream.runDrain(agent.send(session.id, "Stop early").pipe(Stream.take(1)));
          expect(resolved).toBe(0);
          expect((yield* store.runs(session.id))[0]).toMatchObject({
            status: "interrupted",
            failureReason: "consumer-stopped",
          });
          const fiber = yield* Effect.forkChild(Stream.runDrain(agent.send(session.id, "Cancel")));
          yield* Effect.promise(() => ready.promise);
          yield* Fiber.interrupt(fiber);
          expect(yield* store.runs(session.id)).toContainEqual(
            expect.objectContaining({
              status: "interrupted",
              failureReason: "cancelled",
              result: null,
            }),
          );
          expect((yield* store.messages(session.id)).length).toBe(2);
          expect((yield* store.queueRun(session.id, [{ role: "user", text: "Next" }])).status).toBe(
            "pending",
          );
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("a nonterminating model reaches the absolute deadline and leaves an inspectable interrupted run", async () => {
    const state = await fixture(() => Effect.succeed({ description, stream: () => Stream.never }));

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          const started = yield* Deferred.make<void>();

          const fiber = yield* Effect.forkChild(
            Stream.runForEach((yield* Agent).send(session.id, "Hello"), () =>
              Deferred.succeed(started, undefined),
            ),
          );

          yield* Deferred.await(started);
          yield* TestClock.adjust("90 seconds");
          expect(yield* failure(Fiber.join(fiber))).toMatchObject({ reason: "interrupted" });
          expect((yield* store.runs(session.id))[0]?.status).toBe("interrupted");
          expect((yield* store.messages(session.id)).length).toBe(1);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await state.close();
    }
  });
});
