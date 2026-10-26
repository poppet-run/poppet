import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import {
  ProviderError,
  type Completion,
  type ModelEvent,
  type ModelOperations,
  type ModelRequest,
} from "@poppet/provider";
import { Store } from "@poppet/store";
import { Console, Deferred, Effect, Fiber, Match, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AgentError } from "#src/errors";
import { Agent, type ChatEvent, type ModelResolver } from "#src/service";
import { defaultPolicy, type ChatPolicy } from "#src/settings";
import { agentHarness, gatedStream } from "#src/test/harness";

describe("logChatDiagnostic", () => {
  test.each([false, true])(
    "when colour is forced with NO_COLOR=%j, honors the diagnostic colour preference",
    async (disabled) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
      import { Console, Effect } from "effect";
      import { logChatDiagnostic } from "./service.ts";
      await Effect.runPromise(logChatDiagnostic("Session: example").pipe(
        Effect.provideService(Console.Console, {
          ...console,
          error: (text) => console.log(JSON.stringify(text)),
        }),
      ));
    `,
        ],
        {
          cwd: fileURLToPath(new URL(".", import.meta.url)),
          env: disabled ? { FORCE_COLOR: "1", NO_COLOR: "1" } : { FORCE_COLOR: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect({ code, errors }).toEqual({ code: 0, errors: "" });
      expect(JSON.parse(output)).toBe(
        disabled ? "Session: example" : "\u001b[90mSession: example\u001b[39m",
      );
    },
  );
});

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
    images: false,
    generationSettings: ["maxOutputTokens"],
    contextWindow: null,
    maxOutputTokens: 1000,
  },
};

const fixture = async (
  resolve: ModelResolver["Service"]["resolve"],
  logReasoning = false,
  policy: Partial<ChatPolicy> = {},
) => {
  const harness = await agentHarness({ logReasoning, ...policy });
  const layer = harness.agent(resolve);

  return {
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: harness.close,
  };
};

const failure = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));

describe.concurrent("Agent", () => {
  test("when another request holds the shared runner, still names a finished session", async () => {
    const state = await fixture(() =>
      Effect.succeed({
        description,
        stream: (request) => {
          if (request.settings.toolChoice === "none")
            return Stream.make({
              type: "completed" as const,
              response: response("A concise conversation title"),
            });

          const last = request.messages.at(-1);

          return last?.role === "user" && last.text === "Wait"
            ? Stream.never
            : Stream.make({ type: "completed" as const, response: response() });
        },
      }),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const finished = yield* store.createSession("test-provider", "test-model");
          yield* Stream.runDrain(agent.send(finished.id, "First question"));
          const waiting = yield* store.createSession("test-provider", "test-model");
          const started = yield* Deferred.make<void>();

          const running = yield* agent.send(waiting.id, "Wait").pipe(
            Stream.runForEach(() => Deferred.succeed(started, undefined)),
            Effect.forkChild,
          );

          yield* Deferred.await(started);
          yield* agent.nameSession(finished.id).pipe(Effect.timeout("2 seconds"));
          expect((yield* store.session(finished.id))?.title).toBe("A concise conversation title");
          yield* Fiber.interrupt(running);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([
    { name: "default", policy: {}, seconds: 300 },
    { name: "custom", policy: { runDeadlineSeconds: 30 }, seconds: 30 },
  ])(
    "when a run reaches the $name deadline, interrupts it and preserves its input",
    async ({ policy, seconds }) => {
      const state = await fixture(
        () => Effect.succeed({ description, stream: () => Stream.never }),
        false,
        policy,
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");

            const running = yield* failure(
              Stream.runDrain((yield* Agent).send(session.id, "Wait")),
            ).pipe(Effect.forkChild);

            yield* TestClock.adjust((seconds - 1) * 1000);
            expect(running.pollUnsafe()).toBeUndefined();
            expect((yield* store.runs(session.id))[0]?.status).toBe("running");
            yield* TestClock.adjust("1 second");
            expect(yield* Fiber.join(running)).toMatchObject({
              reason: "interrupted",
              message: "The chat request deadline expired.",
            });
            expect((yield* store.runs(session.id))[0]?.status).toBe("interrupted");
            expect((yield* store.messages(session.id)).map((entry) => entry.message)).toEqual([
              { role: "user", text: "Wait" },
            ]);
          }).pipe(Effect.provide(TestClock.layer())),
        );
      } finally {
        await state.close();
      }
    },
  );

  test.each([false, true])(
    "when reasoning is enabled=%j, logs only permitted reasoning without changing the answer",
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
            expect(
              events
                .filter((event) => event.type === "reasoning-delta")
                .map((event) => event.text)
                .join(""),
            ).toBe(enabled ? thinking : "");
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
                logs.push(stripVTControlCharacters(values.join(" ")));
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
    "when a run is %s, flushes remaining reasoning logs",
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

            expect(chunks.join("")).toBe(thinking);
            expect((yield* store.runs(session.id))[0]?.status).toBe(status);
          }).pipe(
            Effect.provideService(Console.Console, {
              ...console,
              error: (...values) => {
                logs.push(stripVTControlCharacters(values.join(" ")));
              },
            }),
          ),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when a session reopens, resumes streaming with its saved identity, workload, and continuation", async () => {
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
    "when the provider fails with %s, persists the failure without retry or partial answers in later context",
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

  test("when model resolution fails, records the failure after saving the input", async () => {
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

  test("when input is oversized or model selection mismatches, rejects it without inference", async () => {
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
            yield* failure(
              Stream.runDrain(agent.send(session.id, "x".repeat(defaultPolicy.contextBytes))),
            ),
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
      name: "oversize continuation",
      events: [
        {
          type: "completed",
          response: {
            ...response(),
            continuation: { ...response().continuation, data: { opaque: "x".repeat(1048576) } },
          },
        },
      ],
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

  test.each(completionCases)(
    "when a completion is $name, refuses to commit it",
    async ({ events, reason }) => {
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
    },
  );

  test("when consumption ends early or is cancelled, releases the active run for the next request", async () => {
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
});

describe("Agent.nameSession", () => {
  test("when naming spans a restart, claims once and isolates title input, continuation, tools, and usage", async () => {
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

  test("when a manual title arrives during generation, preserves the manual title", async () => {
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
    "when naming is %s, preserves the successful answer and fallback title without retrying",
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
              error: (...values) => errors.push(stripVTControlCharacters(values.join(" "))),
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

  test("when earlier exchanges fail, keeps naming eligible and uses the first original prompt", async () => {
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

/** A model whose answer to each prompt waits until the test releases that prompt. */
const gatedModel = () => {
  const { gate, stream } = gatedStream((prompt) =>
    Stream.make({ type: "completed" as const, response: response(`Answer to ${prompt}`) }),
  );

  return { gate, resolve: () => Effect.succeed({ description, stream }) };
};

// Lets unrelated fibers reach the model if nothing holds them back.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe.concurrent("Agent request permits", () => {
  test("when sessions differ, runs up to the limit at once and starts a waiter when a slot frees", async () => {
    const model = gatedModel();
    const state = await fixture(model.resolve, false, { maxConcurrentRequests: 2 });

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;

          const sessions = yield* Effect.forEach(["A", "B", "C"], () =>
            store.createSession("test-provider", "test-model"),
          );

          const fibers = yield* Effect.forEach(sessions, (session, index) =>
            Stream.runDrain(agent.send(session.id, ["A", "B", "C"][index]!)).pipe(Effect.forkChild),
          );

          yield* Deferred.await(model.gate("A").entered);
          yield* Deferred.await(model.gate("B").entered);
          yield* settle;
          expect(yield* Deferred.isDone(model.gate("C").entered)).toBe(false);
          expect(yield* store.runs(sessions[2]!.id)).toEqual([]);

          yield* Deferred.succeed(model.gate("B").release, undefined);
          yield* Deferred.await(model.gate("C").entered);
          yield* Deferred.succeed(model.gate("A").release, undefined);
          yield* Deferred.succeed(model.gate("C").release, undefined);
          yield* Fiber.joinAll(fibers);

          for (const session of sessions)
            expect((yield* store.runs(session.id)).map((run) => run.status)).toEqual(["completed"]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when one session receives two sends, the second waits without holding a shared slot", async () => {
    const model = gatedModel();
    const state = await fixture(model.resolve, false, { maxConcurrentRequests: 2 });

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const busy = yield* store.createSession("test-provider", "test-model");
          const other = yield* store.createSession("test-provider", "test-model");
          const first = yield* Stream.runDrain(agent.send(busy.id, "First")).pipe(Effect.forkChild);
          yield* Deferred.await(model.gate("First").entered);

          const second = yield* Stream.runDrain(agent.send(busy.id, "Second")).pipe(
            Effect.forkChild,
          );

          yield* settle;

          // With the session waiter holding no slot, the other session still starts.
          const unrelated = yield* Stream.runDrain(agent.send(other.id, "Other")).pipe(
            Effect.forkChild,
          );

          yield* Deferred.await(model.gate("Other").entered);
          expect(yield* Deferred.isDone(model.gate("Second").entered)).toBe(false);
          expect((yield* store.runs(busy.id)).map((run) => run.status)).toEqual(["running"]);

          yield* Deferred.succeed(model.gate("First").release, undefined);
          yield* Deferred.await(model.gate("Second").entered);
          expect((yield* store.runs(busy.id)).map((run) => run.status)).toEqual([
            "completed",
            "running",
          ]);
          yield* Deferred.succeed(model.gate("Second").release, undefined);
          yield* Deferred.succeed(model.gate("Other").release, undefined);
          yield* Fiber.joinAll([first, second, unrelated]);

          expect(
            (yield* store.messages(busy.id)).map(({ message }) =>
              message.role === "user" ? message.text : "answer",
            ),
          ).toEqual(["First", "answer", "Second", "answer"]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a request is interrupted while waiting for either permit, creates no run", async () => {
    const model = gatedModel();
    const state = await fixture(model.resolve, false, { maxConcurrentRequests: 1 });

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const agent = yield* Agent;
          const busy = yield* store.createSession("test-provider", "test-model");
          const other = yield* store.createSession("test-provider", "test-model");
          const first = yield* Stream.runDrain(agent.send(busy.id, "First")).pipe(Effect.forkChild);
          yield* Deferred.await(model.gate("First").entered);

          // One waits for its busy session, the other for the only shared slot.
          const sameSession = yield* Stream.runDrain(agent.send(busy.id, "Same")).pipe(
            Effect.forkChild,
          );

          const otherSession = yield* Stream.runDrain(agent.send(other.id, "Other")).pipe(
            Effect.forkChild,
          );

          yield* settle;
          yield* Fiber.interrupt(sameSession);
          yield* Fiber.interrupt(otherSession);
          yield* Deferred.succeed(model.gate("First").release, undefined);
          yield* Fiber.join(first);

          expect((yield* store.runs(busy.id)).map((run) => run.status)).toEqual(["completed"]);
          expect(yield* store.runs(other.id)).toEqual([]);

          // Released permits serve later requests to both sessions.
          yield* Deferred.succeed(model.gate("Later").release, undefined);
          yield* Stream.runDrain(agent.send(busy.id, "Later"));
          yield* Stream.runDrain(agent.send(other.id, "Later"));
          expect(yield* store.runs(other.id)).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
