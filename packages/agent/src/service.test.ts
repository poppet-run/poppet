import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import {
  ProviderError,
  type Completion,
  type ModelEvent,
  type ModelOperations,
  type ModelRequest,
} from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Console, Deferred, Effect, Fiber, Layer, Match, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AgentError } from "#src/errors";
import { Notes } from "#src/notes";
import { Pages } from "#src/pages";
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

const fixture = async (resolve: ModelResolver["Service"]["resolve"], logReasoning = false) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-agent-"));

  const store = StoreLive.pipe(
    Layer.provideMerge(
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
        LocalMemoryLive.pipe(Layer.provide(store)),
        Layer.succeed(Pages, { fetch: () => Effect.die("Unexpected page fetch") }),
        Layer.succeed(Notes, {
          execute: () =>
            Effect.fail(
              new AgentError({ reason: "tool-permission", message: "No fixture tools allowed" }),
            ),
        }),
        Layer.succeed(ModelResolver, { resolve }),
        Layer.succeed(ChatSettings, { ...defaultPolicy, logReasoning }),
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

describe.concurrent("persisted agent", () => {
  test.each([false, true])(
    "logs reasoning only when enabled=%s without changing the answer",
    async (enabled) => {
      const requests: ModelRequest[] = [];
      const logs: string[] = [];
      const thinking = "Check the notes\nThen answer.\u001b[31m";

      const state = await fixture(
        () =>
          Effect.succeed({
            description,
            stream: (request) => {
              requests.push(request);

              return Stream.make<ModelEvent[]>(
                { type: "reasoning-delta", text: thinking.slice(0, 5) },
                { type: "reasoning-delta", text: thinking.slice(5) },
                { type: "text-delta", text: "Hel" },
                { type: "completed", response: response() },
              );
            },
          }),
        enabled,
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");
            const events = yield* Stream.runCollect((yield* Agent).send(session.id, "Hello"));
            const diagnostics = events.filter((event) => event.type === "reasoning");

            expect(diagnostics.map((event) => event.text)).toEqual(logs);
            expect(
              events
                .filter((event) => event.type === "text-delta")
                .map((event) => event.text)
                .join(""),
            ).toBe("Hello");
            expect((yield* store.runs(session.id))[0]?.result).toEqual(response());
            expect(requests[0]?.settings.reasoningSummary).toBe(enabled ? true : undefined);
            expect(logs).toHaveLength(enabled ? 2 : 0);

            if (enabled) {
              expect(
                logs.every((line) => line.includes(`Thinking session=${session.id} run=`)),
              ).toBe(true);
              expect(
                logs.map((line) => JSON.parse(line.slice(line.indexOf(' "') + 1))).join(""),
              ).toBe(thinking);
              expect(logs.join("")).not.toContain("\u001b");
            }
          }).pipe(
            Effect.provideService(Console.Console, {
              ...console,
              error: (...values) => {
                logs.push(values.join(" "));
              },
            }),
          ),
        );
      } finally {
        await state.close();
      }
    },
  );

  test.each(["failed", "interrupted"])(
    "flushes bounded reasoning logs for a %s run",
    async (status) => {
      const logs: string[] = [];
      const thinking = "x".repeat(4097);

      const state = await fixture(
        () =>
          Effect.succeed({
            description,
            stream: () =>
              Stream.concat(
                Stream.make({ type: "reasoning-delta" as const, text: thinking }),
                Stream.fail(
                  new ProviderError({
                    provider: "test-provider",
                    reason: "temporary",
                    message: "Failed",
                  }),
                ),
              ),
          }),
        true,
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");
            const stream = (yield* Agent).send(session.id, "Hello");

            if (status === "interrupted") yield* Stream.runDrain(stream.pipe(Stream.take(2)));
            else
              expect(yield* failure(Stream.runDrain(stream))).toMatchObject({
                reason: "temporary",
              });

            const chunks: string[] = logs.map((line) =>
              JSON.parse(line.slice(line.indexOf(' "') + 1)),
            );

            expect(chunks.map((text) => text.length)).toEqual([2048, 2048, 1]);
            expect(chunks.join("")).toBe(thinking);
            expect((yield* store.runs(session.id))[0]?.status).toBe(status);
          }).pipe(
            Effect.provideService(Console.Console, {
              ...console,
              error: (...values) => {
                logs.push(values.join(" "));
              },
            }),
          ),
        );
      } finally {
        await state.close();
      }
    },
  );

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

          const session = yield* store.createSession("test-provider", "test-model", {
            workload: "coding",
          });

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
      name: "oversize",
      events: [{ type: "completed", response: response("x".repeat(131073)) }],
      reason: "output-limit",
    },
    {
      name: "oversize reasoning",
      events: [{ type: "reasoning-delta", text: "x".repeat(131073) }],
      reason: "output-limit",
    },
    {
      name: "trailing reasoning",
      events: [
        { type: "completed", response: response() },
        { type: "reasoning-delta", text: "extra" },
      ],
      reason: "protocol",
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

describe("session naming", () => {
  test("claims once across restart and isolates title input, continuation, tools and usage", async () => {
    const requests: ModelRequest[] = [];

    const state = await fixture(() =>
      Effect.succeed({
        description,
        stream: (request) => {
          requests.push(request);

          return Stream.make({
            type: "completed" as const,
            response:
              request.settings.toolChoice === "none"
                ? response("A concise conversation title")
                : response(),
          });
        },
      }),
    );

    try {
      const id = await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;

          const session = yield* store.createSession(description.provider, description.id, {
            workload: "coding",
          });

          yield* Stream.runDrain(agent.send(session.id, "First\n  question\u0000 with 😀"));
          expect(yield* store.session(session.id)).toMatchObject({
            title: "First question with 😀",
            titleSource: "fallback",
            titleAttempted: false,
          });
          const before = yield* store.session(session.id);
          yield* agent.nameSession(session.id);
          yield* agent.nameSession(session.id);
          expect(yield* store.session(session.id)).toMatchObject({
            title: "A concise conversation title",
            titleSource: "generated",
            titleAttempted: true,
            titleUsage: { inputTokens: 3, outputTokens: 2 },
            updatedAt: before?.updatedAt,
          });
          expect(yield* store.messages(session.id)).toHaveLength(2);
          expect((yield* store.runs(session.id))[0]?.result?.usage).toEqual({
            inputTokens: 3,
            outputTokens: 2,
          });

          return session.id;
        }),
      );

      await state.run(Agent.use((agent) => agent.nameSession(id)));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        sessionId: id,
        workload: "coding",
        tools: [],
        settings: { maxOutputTokens: 128, toolChoice: "none" },
        messages: [{ role: "user", text: JSON.stringify("First\n  question\u0000 with 😀") }],
      });
      expect(requests[1]?.instructions).not.toContain("profile");
    } finally {
      await state.close();
    }
  });

  test("a manual title wins while generation is in flight", async () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();

    const state = await fixture(() =>
      Effect.succeed({
        description,
        stream: (request) =>
          request.settings.toolChoice === "none"
            ? Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({
                    type: "completed" as const,
                    response: response("Late generated title"),
                  }),
                ),
              )
            : Stream.make({ type: "completed" as const, response: response() }),
      }),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession(description.provider, description.id);
          yield* Stream.runDrain(agent.send(session.id, "Original title"));
          const fiber = yield* agent.nameSession(session.id).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* store.renameSession(session.id, "My chosen title");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          expect(yield* store.session(session.id)).toMatchObject({
            title: "My chosen title",
            titleSource: "manual",
            titleAttempted: true,
            titleUsage: { inputTokens: 3, outputTokens: 2 },
          });
          expect((yield* store.runs(session.id))[0]?.status).toBe("completed");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each(["empty", "invalid", "oversized", "deadline", "cancelled"])(
    "keeps the successful answer and fallback after %s naming, without retry",
    async (mode) => {
      let names = 0;
      const errors: string[] = [];
      const started = Deferred.makeUnsafe<void>();

      const state = await fixture(() =>
        Effect.succeed({
          description,
          stream: (request) => {
            if (request.settings.toolChoice !== "none")
              return Stream.make({ type: "completed" as const, response: response() });
            names++;

            if (mode === "deadline" || mode === "cancelled")
              return Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              );

            return Stream.make({
              type: "completed" as const,
              response: response(
                Match.value(mode).pipe(
                  Match.when("empty", () => "\u0000\n  "),
                  Match.when("oversized", () => "x".repeat(1025)),
                  Match.orElse(() => "Refused"),
                ),
              ),
            }).pipe(
              mode === "invalid"
                ? Stream.concat(
                    Stream.fail(
                      new ProviderError({
                        provider: description.provider,
                        reason: "temporary",
                        message: "Late failure",
                      }),
                    ),
                  )
                : (stream) => stream,
            );
          },
        }),
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const agent = yield* Agent;
            const session = yield* store.createSession(description.provider, description.id);
            yield* Stream.runDrain(agent.send(session.id, "Keep this fallback"));

            if (mode === "deadline" || mode === "cancelled") {
              const fiber = yield* agent.nameSession(session.id).pipe(Effect.forkChild);
              yield* Deferred.await(started);

              if (mode === "deadline") {
                yield* TestClock.adjust("10 seconds");
                yield* Fiber.join(fiber);
              } else yield* Fiber.interrupt(fiber);
            } else yield* agent.nameSession(session.id);
            yield* agent.nameSession(session.id);
            expect(yield* store.session(session.id)).toMatchObject({
              title: "Keep this fallback",
              titleSource: "fallback",
              titleAttempted: true,
            });
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: "completed",
              result: response(),
            });
          }).pipe(
            Effect.provide(TestClock.layer()),
            Effect.provideService(Console.Console, {
              ...console,
              error: (...values) => errors.push(values.join(" ")),
            }),
          ),
        );
        expect(names).toBe(1);
        expect(errors).toHaveLength(["invalid", "oversized", "deadline"].includes(mode) ? 1 : 0);
      } finally {
        await state.close();
      }
    },
  );

  test("failed exchanges remain eligible and naming always uses the first original prompt", async () => {
    let fail = true;
    const requests: ModelRequest[] = [];

    const state = await fixture(() =>
      Effect.succeed({
        description,
        stream: (request) => {
          requests.push(request);

          if (fail)
            return Stream.fail(
              new ProviderError({
                provider: description.provider,
                reason: "temporary",
                message: "Try later",
              }),
            );

          return Stream.make({
            type: "completed" as const,
            response: response("Recovered conversation"),
          });
        },
      }),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const session = yield* store.createSession(description.provider, description.id);
          yield* Stream.runDrain(agent.send(session.id, "Original prompt")).pipe(Effect.ignore);
          yield* agent.nameSession(session.id);
          expect((yield* store.session(session.id))?.titleAttempted).toBe(false);
          fail = false;
          yield* Stream.runDrain(agent.send(session.id, "Retry prompt"));
          yield* agent.nameSession(session.id);
          expect(requests.at(-1)?.messages).toEqual([
            { role: "user", text: JSON.stringify("Original prompt") },
          ]);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
