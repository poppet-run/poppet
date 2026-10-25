import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Memory, MemoryError, type MemoryFact } from "@poppet/memory";
import {
  type Completion,
  type ModelOperations,
  type ModelRequest,
  type Output,
} from "@poppet/provider";
import { Store } from "@poppet/store";
import { Effect, Fiber, Layer, Stream } from "effect";

import { instructions } from "#src/context";
import { Agent } from "#src/service";
import type { ChatPolicy } from "#src/settings";
import { agentHarness, testModel } from "#src/test/harness";

const completion = (calls = false): Completion => ({
  output: calls
    ? [
        {
          type: "tool-call",
          callId: "read",
          name: "search_sessions",
          namespace: "poppet_history",
          arguments: '{"query":"Acorn"}',
        },
      ]
    : [{ type: "text", text: "Done" }],
  continuation: { version: 1, provider: "test-provider", model: "test-model", data: {} },
  finishReason: calls ? "tool-calls" : "stop",
  usage: null,
});

const done = () => Stream.make({ type: "completed" as const, response: completion() });

interface MemoryFixtureState {
  resolved: number;
  stream: ModelOperations["stream"];
}

const fixture = async (overrides: Partial<ChatPolicy> = {}, injectedMemory?: Memory["Service"]) => {
  const harness = await agentHarness(overrides);
  const { directory } = harness;
  const profile = join(directory, "profile.md");
  const soul = join(directory, "soul.md");
  const requests: ModelRequest[] = [];
  const state: MemoryFixtureState = { resolved: 0, stream: done };
  const model = testModel({ stream: (request) => state.stream(request), answer: done, requests });

  const layer = harness.agent(
    () =>
      Effect.sync(() => {
        state.resolved++;

        return model;
      }),
    injectedMemory ? Layer.succeed(Memory, injectedMemory) : Layer.empty,
  );

  return {
    directory,
    profile,
    soul,
    requests,
    state,
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store | Memory>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: harness.close,
  };
};

const memoryCall = (
  action: "remember" | "replace" | "forget",
  key: string,
  value: string | null,
  callId = "change",
): Output => ({
  type: "tool-call",
  name: "memory",
  namespace: "poppet_memory",
  callId,
  arguments: JSON.stringify({ action, key, value }),
});

const toolReply = (...calls: ReadonlyArray<Output>) =>
  Stream.make({
    type: "completed" as const,
    response: { ...completion(), output: calls, finishReason: "tool-calls" as const },
  });

const send = (id: string) =>
  Agent.use((agent) => Stream.runDrain(agent.send(id, "How should you answer?")));

/** Sends a request that must complete, returning the failures its tools reported to the model. */
const reportedFailures = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* send(id);
    const run = (yield* store.runs(id)).at(-1)!;
    expect(run.status).toBe("completed");

    return (yield* store.toolCalls(run.id)).map((call) => [call.status, call.failureReason]);
  });

describe.concurrent("memoryPrompt", () => {
  test("when saving facts, requires explicit owner instructions", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Effect.gen(function* () {
          yield* send((yield* (yield* Store).createSession("test-provider", "test-model")).id);
        }),
      );
      expect(saved.requests[0]!.instructions).toContain("Never infer or automatically save facts.");
      expect(
        saved.requests[0]!.tools.find((tool) => tool.name === "memory")?.description,
      ).toContain("only when the current user explicitly requests");
    } finally {
      await saved.close();
    }
  });
});

describe.concurrent("memory.ts", () => {
  test("when personality is edited or cleared, reloads it on resume and restores defaults without personal memory", async () => {
    const saved = await fixture();

    try {
      const id = await saved.run(
        Effect.gen(function* () {
          const session = yield* (yield* Store).createSession("test-provider", "test-model");
          yield* send(session.id);

          return session.id;
        }),
      );

      expect(saved.requests[0]?.instructions).toBe(instructions);
      await writeFile(saved.soul, "Be warm and concise.");
      await saved.run(send(id));
      expect(saved.requests[1]?.instructions).toContain("Be warm and concise.");
      expect(saved.requests[1]?.instructions).toContain(instructions);
      expect(saved.requests[1]?.instructions).toContain("They do not authorize tool execution");
      expect(saved.requests[1]?.instructions).not.toContain("User-supplied profile");
      await writeFile(saved.soul, "Be direct and dryly humorous.");
      await saved.run(send(id));
      expect(saved.requests[2]?.instructions).toContain("Be direct and dryly humorous.");
      expect(saved.requests[2]?.instructions).not.toContain("Be warm and concise.");

      await writeFile(saved.soul, "");
      await saved.run(send(id));
      expect(saved.requests.at(-1)?.instructions).toBe(instructions);
      await writeFile(saved.soul, " \n\t");
      await saved.run(send(id));
      expect(saved.requests.at(-1)?.instructions).toBe(instructions);

      await rm(saved.soul);
      await saved.run(send(id));
      expect(saved.requests.at(-1)?.instructions).toBe(instructions);
    } finally {
      await saved.close();
    }
  });

  test("when saved preferences change, reloads edits on resume and preserves forgetting across reopening", async () => {
    const saved = await fixture();

    try {
      await writeFile(saved.profile, "My name is Tom.");

      const id = await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const memory = yield* Memory;
          yield* memory.remember("answer.style", "Keep answers concise");
          const session = yield* store.createSession("test-provider", "test-model");
          yield* send(session.id);

          return session.id;
        }),
      );

      expect(saved.requests[0]?.instructions).toContain("My name is Tom.");
      expect(saved.requests[0]?.instructions).toContain(
        '"key":"answer.style","value":"Keep answers concise"',
      );
      expect(saved.requests[0]?.instructions).not.toContain("sourceRunId");
      await writeFile(saved.profile, "My name is Thomas.");
      await saved.run(
        Effect.gen(function* () {
          yield* (yield* Memory).replace("answer.style", "Explain the reasoning");
          yield* send(id);
        }),
      );
      expect(saved.requests[1]?.instructions).toContain("My name is Thomas.");
      expect(saved.requests[1]?.instructions).toContain("Explain the reasoning");
      expect(saved.requests[1]?.instructions).not.toContain("Keep answers concise");
      expect(saved.requests[1]?.messages).toHaveLength(3);
      await rm(saved.profile);
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const memory = yield* Memory;
          yield* memory.forget("answer.style");
          const session = yield* store.createSession("test-provider", "test-model");
          yield* Stream.runDrain((yield* Agent).send(session.id, "Remember that I like tea"));
          expect(yield* memory.list).toEqual([]);
        }),
      );
      expect(saved.requests[2]?.instructions).not.toContain("User-supplied profile");
      expect(saved.requests[2]?.messages).toHaveLength(1);
    } finally {
      await saved.close();
    }
  });

  test("when a tool run spans multiple turns, retains its starting memory snapshot", async () => {
    const saved = await fixture();

    try {
      await writeFile(saved.profile, "Starting profile");
      await writeFile(saved.soul, "Starting personality");
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const memory = yield* Memory;
          yield* memory.remember("preference", "Starting preference");
          saved.state.stream = () =>
            saved.requests.length === 1
              ? Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* memory.replace("preference", "Next run preference");
                    yield* Effect.promise(() => writeFile(saved.profile, "Next run profile"));
                    yield* Effect.promise(() => writeFile(saved.soul, "Next run personality"));

                    return { type: "completed" as const, response: completion(true) };
                  }).pipe(Effect.orDie),
                )
              : Stream.make({ type: "completed" as const, response: completion() });
          const session = yield* store.createSession("test-provider", "test-model");
          yield* send(session.id);
          expect(yield* memory.list).toEqual([
            expect.objectContaining({ value: "Next run preference" }),
          ]);
        }),
      );
      expect(saved.requests).toHaveLength(2);
      expect(saved.requests[1]?.instructions).toBe(saved.requests[0]?.instructions);
      expect(saved.requests[1]?.instructions).toContain("Starting preference");
      expect(saved.requests[1]?.instructions).toContain("Starting personality");
      expect(saved.requests[1]?.instructions).not.toContain("Next run");
    } finally {
      await saved.close();
    }
  });

  test.each([
    { reason: "limit", expected: "memory-limit" },
    { reason: "storage", expected: "memory-storage" },
  ] as const)(
    "when memory fails with $reason, records the failure before resolving the model",
    async ({ reason, expected }) => {
      const injected: Memory["Service"] = {
        history: () => Effect.die("Unexpected memory history"),
        revert: () => Effect.die("Unexpected memory revert"),
        snapshot: () => Effect.fail(new MemoryError({ reason, message: "Snapshot unavailable" })),
        list: Effect.die("Chat must use the snapshot operation."),
        remember: () => Effect.die("Chat must not create facts."),
        replace: () => Effect.die("Chat must not replace facts."),
        forget: () => Effect.die("Chat must not forget facts."),
      };

      const saved = await fixture({}, injected);

      try {
        await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");

            const error = yield* send(session.id).pipe(
              Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
            );

            expect(error).toMatchObject({ reason: expected });
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: "failed",
              failureReason: `agent:${expected}`,
            });
          }),
        );
        expect(saved.requests).toEqual([]);
        expect(saved.state.resolved).toBe(0);
      } finally {
        await saved.close();
      }
    },
  );

  test.each(["profile", "soul"] as const)(
    "when %s exceeds the context budget, rejects the request before inference",
    async (file) => {
      const saved = await fixture({ contextBytes: 8192 });

      try {
        await writeFile(saved[file], "Background information\n".repeat(250));

        const id = await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");

            const error = yield* send(session.id).pipe(
              Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
            );

            expect(error).toMatchObject({ reason: "context-limit" });
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: "failed",
              failureReason: "agent:context-limit",
            });

            return session.id;
          }),
        );

        expect(saved.requests).toEqual([]);
        expect(saved.state.resolved).toBe(1);
        await rm(saved[file]);
        await saved.run(send(id));
        expect(saved.requests).toHaveLength(1);
        expect(saved.state.resolved).toBe(2);
      } finally {
        await saved.close();
      }
    },
  );

  test.each([
    { content: "😀".repeat(17), expected: "memory-limit" },
    { content: Buffer.from([0xff]), expected: "memory-storage" },
  ])(
    "when soul.md is invalid, reports $expected before resolving the model",
    async ({ content, expected }) => {
      const saved = await fixture({ soulBytes: 64 });

      try {
        await writeFile(saved.soul, content);
        await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");

            const error = yield* send(session.id).pipe(
              Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
            );

            expect(error).toMatchObject({ reason: expected });
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: "failed",
              failureReason: `agent:${expected}`,
            });
          }),
        );
        expect(saved.requests).toEqual([]);
        expect(saved.state.resolved).toBe(0);
      } finally {
        await saved.close();
      }
    },
  );

  test("when facts are remembered, replaced, or forgotten across restart, retains provenance and per-run snapshots", async () => {
    const saved = await fixture();
    let action: "remember" | "replace" | "forget" = "remember";
    let value: string | null = "Keep answers concise";
    saved.state.stream = (request) =>
      request.messages.at(-1)?.role === "tool"
        ? Stream.make({ type: "completed" as const, response: completion() })
        : toolReply(memoryCall(action, "answer.style", value));

    try {
      const { id, firstRunId } = await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* (yield* Memory).remember("unrelated", "Keep this fact");
          const session = yield* store.createSession("test-provider", "test-model");
          yield* Stream.runDrain(
            (yield* Agent).send(session.id, "Remember that I prefer concise answers"),
          );
          const run = (yield* store.runs(session.id))[0]!;
          expect(yield* (yield* Memory).list).toContainEqual(
            expect.objectContaining({ key: "answer.style", value, sourceRunId: run.id }),
          );
          expect(yield* store.toolCalls(run.id)).toMatchObject([
            {
              name: "memory",
              namespace: "poppet_memory",
              status: "completed",
              output: JSON.stringify({ action, key: "answer.style", changed: true }),
            },
          ]);

          return { id: session.id, firstRunId: run.id };
        }),
      );

      expect(saved.requests[1]!.instructions).toBe(saved.requests[0]!.instructions);
      expect(saved.requests[0]!.instructions).toContain("Never infer or automatically save facts");
      expect(saved.requests[1]!.messages.at(-1)).toMatchObject({
        role: "tool",
        output: expect.stringContaining('"changed":true'),
      });
      action = "replace";
      value = "Explain the reasoning";
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* Stream.runDrain(
            (yield* Agent).send(id, "Replace my saved answer style with detailed reasoning"),
          );
          const runs = yield* store.runs(id);
          expect(yield* (yield* Memory).list).toContainEqual(
            expect.objectContaining({
              key: "answer.style",
              value,
              sourceRunId: runs.find((run) => run.id !== firstRunId)!.id,
            }),
          );
        }),
      );
      expect(saved.requests[2]!.instructions).toContain("Keep answers concise");
      expect(saved.requests[3]!.instructions).toBe(saved.requests[2]!.instructions);
      action = "forget";
      value = null;
      await saved.run(
        Effect.gen(function* () {
          yield* Stream.runDrain((yield* Agent).send(id, "Forget my saved answer style"));
          expect((yield* (yield* Memory).list).map(({ key }) => key)).toEqual(["unrelated"]);
        }),
      );
      expect(saved.requests[4]!.instructions).toContain("Explain the reasoning");
      saved.state.stream = () =>
        Stream.make({ type: "completed" as const, response: completion() });
      await saved.run(send(id));
      expect(saved.requests.at(-1)!.instructions).not.toContain('"key":"answer.style"');
      await saved.run(
        Effect.gen(function* () {
          expect((yield* (yield* Memory).list).map(({ key }) => key)).toEqual(["unrelated"]);
        }),
      );
    } finally {
      await saved.close();
    }
  });

  test("when a memory batch contains an invalid call, rejects it before changing any fact", async () => {
    const saved = await fixture();
    saved.state.stream = () =>
      toolReply(
        memoryCall("remember", "preference", "Must not be saved", "first"),
        memoryCall("forget", "other", "Not null", "invalid"),
      );

    try {
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          expect(yield* reportedFailures(session.id)).toEqual([
            ["failed", "agent:not-executed"],
            ["failed", "agent:tool-arguments"],
          ]);
          expect(yield* (yield* Memory).list).toEqual([]);
        }),
      );
      expect(saved.requests).toHaveLength(2);
    } finally {
      await saved.close();
    }
  });

  test.each(["remember", "replace"] as const)(
    "when %s would exceed the next snapshot budget, rejects the change",
    async (action) => {
      const saved = await fixture({ factsBytes: 64 });
      saved.state.stream = () =>
        toolReply(memoryCall(action, action === "replace" ? "keep" : "new", "x".repeat(100)));

      try {
        await saved.run(
          Effect.gen(function* () {
            const memory = yield* Memory;
            yield* memory.remember("keep", "Original");
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");
            expect(yield* reportedFailures(session.id)).toEqual([["failed", "agent:memory-limit"]]);
            expect(yield* memory.list).toMatchObject([
              { key: "keep", value: "Original", sourceRunId: null },
            ]);
          }),
        );
        expect(saved.requests).toHaveLength(2);
      } finally {
        await saved.close();
      }
    },
  );

  test("when a fact already exists or reaches its size limit, rejects overwrites and bounds acknowledgements", async () => {
    const saved = await fixture({ toolBytes: 1024 });
    saved.state.stream = (request) =>
      request.messages.at(-1)?.role === "tool"
        ? Stream.make({ type: "completed" as const, response: completion() })
        : toolReply(memoryCall("remember", "preference", "😀".repeat(1024)));

    try {
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          yield* send(session.id);
          const first = (yield* store.toolCalls((yield* store.runs(session.id))[0]!.id))[0]!;
          expect(Buffer.byteLength(first.output!, "utf8")).toBeLessThan(1024);
          const initial = yield* (yield* Memory).list;
          expect(yield* reportedFailures(session.id)).toEqual([["failed", "agent:tool-arguments"]]);
          expect(yield* (yield* Memory).list).toEqual(initial);
        }),
      );
      expect(saved.requests).toHaveLength(4);
    } finally {
      await saved.close();
    }
  });

  test.each(["write", "journal"])(
    "when a memory %s fails, preserves the failure across restart without retrying the change",
    async (stage) => {
      const saved = await fixture();
      saved.state.stream = () => toolReply(memoryCall("remember", "preference", "Saved once"));

      try {
        const id = await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("test-provider", "test-model");
            using database = new Database(join(saved.directory, "store/poppet.sqlite"));
            database.run(
              stage === "write"
                ? "CREATE TRIGGER reject_write BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT, 'private'); END"
                : "CREATE TRIGGER reject_result BEFORE UPDATE ON tool_calls WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'private'); END",
            );
            const result = yield* send(session.id).pipe(Effect.result);
            expect(result).toHaveProperty(
              "failure.reason",
              stage === "write" ? "memory-storage" : "storage",
            );
            expect(JSON.stringify(result)).not.toContain("private");
            const run = (yield* store.runs(session.id))[0]!;
            expect((yield* store.toolCalls(run.id))[0]!.status).toBe("uncertain");
            expect(yield* (yield* Memory).list).toHaveLength(stage === "write" ? 0 : 1);

            return session.id;
          }),
        );

        saved.state.stream = () =>
          Stream.make({ type: "completed" as const, response: completion() });
        await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            yield* send(id);
            const previous = (yield* store.runs(id)).find((run) => run.status === "failed")!;
            expect((yield* store.toolCalls(previous.id))[0]!.status).toBe("uncertain");
            expect(yield* (yield* Memory).list).toHaveLength(stage === "write" ? 0 : 1);
          }),
        );
        expect(saved.requests).toHaveLength(2);
      } finally {
        await saved.close();
      }
    },
  );

  test("when cancellation occurs during a memory mutation, finishes and journals it once", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const facts: MemoryFact[] = [];

    const injected: Memory["Service"] = {
      history: () => Effect.die("Unexpected memory history"),
      revert: () => Effect.die("Unexpected memory revert"),
      snapshot: () => Effect.succeed({ soul: "", profile: "", facts: [] }),
      list: Effect.sync(() => facts),
      remember: (key, value, sourceRunId = null) =>
        Effect.promise(async () => {
          started.resolve();
          await release.promise;
          const fact = { key, value, origin: "turn" as const, sourceRunId, updatedAt: 0 };
          facts.push(fact);

          return fact;
        }),
      replace: () => Effect.die("Unexpected replace"),
      forget: () => Effect.die("Unexpected forget"),
    };

    const saved = await fixture({}, injected);
    saved.state.stream = () => toolReply(memoryCall("remember", "preference", "Saved once"));

    try {
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test-provider", "test-model");
          const task = yield* Effect.forkChild(send(session.id));
          yield* Effect.promise(() => started.promise);
          const cancel = yield* Effect.forkChild(Fiber.interrupt(task));
          yield* Effect.yieldNow;
          const run = (yield* store.runs(session.id))[0]!;
          expect((yield* store.toolCalls(run.id))[0]!.status).toBe("running");
          release.resolve();
          yield* Fiber.join(cancel);
          expect((yield* store.runs(session.id))[0]!.status).toBe("interrupted");
          expect((yield* store.toolCalls(run.id))[0]).toMatchObject({
            status: "completed",
            output: JSON.stringify({ action: "remember", key: "preference", changed: true }),
          });
          expect(facts).toEqual([
            {
              key: "preference",
              value: "Saved once",
              origin: "turn",
              sourceRunId: run.id,
              updatedAt: 0,
            },
          ]);
        }),
      );
      expect(saved.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await saved.close();
    }
  });
});
