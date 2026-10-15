import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Memory, MemoryError, LocalMemoryLive, type SnapshotLimits } from "@poppet/memory";
import { type Completion, type ModelOperations, type ModelRequest } from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Effect, Layer, Stream } from "effect";

import { instructions } from "#src/context";
import { Notes } from "#src/notes";
import { Agent, AgentLive, ModelResolver } from "#src/service";
import { ChatSettings, defaultPolicy, type ChatPolicy } from "#src/settings";

const completion = (calls = false): Completion => ({
  output: calls
    ? [
        {
          type: "tool-call",
          callId: "read",
          name: "read_note",
          namespace: "poppet_notes",
          arguments: '{"path":"a.md"}',
        },
      ]
    : [{ type: "text", text: "Done" }],
  continuation: { version: 1, provider: "test-provider", model: "test-model", data: {} },
  finishReason: calls ? "tool-calls" : "stop",
  usage: null,
});

interface MemoryFixtureState {
  resolved: number;
  stream: ModelOperations["stream"];
}

const fixture = async (overrides: Partial<ChatPolicy> = {}, injectedMemory?: Memory["Service"]) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-memory-agent-"));
  const profile = join(directory, "profile.md");
  const soul = join(directory, "soul.md");
  const requests: ModelRequest[] = [];

  const state: MemoryFixtureState = {
    resolved: 0,
    stream: () => Stream.make({ type: "completed" as const, response: completion() }),
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test-provider",
    model: "test-model",
  });

  const model: ModelOperations = {
    description: {
      provider: "test-provider",
      id: "test-model",
      name: "Test",
      capabilities: {
        tools: true,
        generationSettings: [],
        contextWindow: null,
        maxOutputTokens: null,
      },
    },
    stream: (request) => {
      requests.push(request);

      return state.stream(request);
    },
  };

  const store = StoreLive.pipe(Layer.provideMerge(config));

  const memory = injectedMemory
    ? Layer.succeed(Memory, injectedMemory)
    : LocalMemoryLive.pipe(Layer.provide(store));

  const layer = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        memory,
        Layer.succeed(ChatSettings, { ...defaultPolicy, ...overrides }),
        Layer.succeed(Notes, { execute: () => Effect.succeed("Note contents") }),
        Layer.succeed(ModelResolver, {
          resolve: () =>
            Effect.sync(() => {
              state.resolved++;

              return model;
            }),
        }),
      ),
    ),
  );

  return {
    directory,
    profile,
    soul,
    requests,
    state,
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store | Memory>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const send = (id: string) =>
  Agent.use((agent) => Stream.runDrain(agent.send(id, "How should you answer?")));

describe.concurrent("explicit memory in chat", () => {
  test("uses an injected memory implementation without reading the local profile or facts", async () => {
    const snapshots: SnapshotLimits[] = [];

    const injected: Memory["Service"] = {
      snapshot: (limits) =>
        Effect.sync(() => {
          snapshots.push(limits);

          return {
            soul: "Speak like a patient tutor",
            profile: "From another implementation",
            facts: [{ key: "answer.style", value: "Use short answers" }],
          };
        }),
      list: Effect.die("Chat must use the snapshot operation."),
      remember: () => Effect.die("Chat must not create facts."),
      replace: () => Effect.die("Chat must not replace facts."),
      forget: () => Effect.die("Chat must not forget facts."),
    };

    const saved = await fixture({ profileBytes: 32, factsBytes: 128 }, injected);

    try {
      await writeFile(saved.profile, Buffer.from([0xff]));
      await writeFile(saved.soul, Buffer.from([0xff]));
      await saved.run(
        Effect.gen(function* () {
          const session = yield* (yield* Store).createSession("test-provider", "test-model");
          yield* send(session.id);
        }),
      );
      expect(snapshots).toEqual([{ soulBytes: 8192, profileBytes: 32, factsBytes: 128 }]);
      expect(saved.requests[0]?.instructions).toContain("Speak like a patient tutor");
      expect(saved.requests[0]?.instructions).toContain("From another implementation");
      expect(saved.requests[0]?.instructions).toContain("Use short answers");
    } finally {
      await saved.close();
    }
  });

  test("loads personality without personal memory, reloads on resume and restores defaults when cleared", async () => {
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

  test("uses saved preferences in fresh sessions, reloads edits on resume and forgets across reopening", async () => {
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

  test("keeps the starting memory snapshot throughout a multi-turn tool run", async () => {
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
    "records an injected $reason memory failure before resolving the model",
    async ({ reason, expected }) => {
      const injected: Memory["Service"] = {
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
    "counts %s toward the overall context budget before inference",
    async (file) => {
      const saved = await fixture({ contextBytes: 4096 });

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
    "rejects an invalid soul.md with $expected before resolving the model",
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
});
