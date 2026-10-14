import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { type Completion, type ModelOperations, type ModelRequest } from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Effect, Layer, Stream } from "effect";

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

const fixture = async (overrides: Partial<ChatPolicy> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-memory-agent-"));
  const profile = join(directory, "profile.md");
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

  const layer = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        config,
        StoreLive.pipe(Layer.provide(config)),
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
    requests,
    state,
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const send = (id: string) =>
  Agent.use((agent) => Stream.runDrain(agent.send(id, "How should you answer?")));

describe("explicit memory in chat", () => {
  test("uses saved preferences in fresh sessions, reloads edits on resume and forgets across reopening", async () => {
    const saved = await fixture();

    try {
      await writeFile(saved.profile, "My name is Tom.");

      const id = await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.rememberMemory("answer.style", "Keep answers concise");
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
          yield* (yield* Store).replaceMemory("answer.style", "Explain the reasoning");
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
          yield* store.forgetMemory("answer.style");
          const session = yield* store.createSession("test-provider", "test-model");
          yield* Stream.runDrain((yield* Agent).send(session.id, "Remember that I like tea"));
          expect(yield* store.memories).toEqual([]);
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
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.rememberMemory("preference", "Starting preference");
          saved.state.stream = () =>
            saved.requests.length === 1
              ? Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* store.replaceMemory("preference", "Next run preference");
                    yield* Effect.promise(() => writeFile(saved.profile, "Next run profile"));

                    return { type: "completed" as const, response: completion(true) };
                  }).pipe(Effect.orDie),
                )
              : Stream.make({ type: "completed" as const, response: completion() });
          const session = yield* store.createSession("test-provider", "test-model");
          yield* send(session.id);
          expect(yield* store.memories).toEqual([
            expect.objectContaining({ value: "Next run preference" }),
          ]);
        }),
      );
      expect(saved.requests).toHaveLength(2);
      expect(saved.requests[1]?.instructions).toBe(saved.requests[0]?.instructions);
      expect(saved.requests[1]?.instructions).toContain("Starting preference");
      expect(saved.requests[1]?.instructions).not.toContain("Next run");
    } finally {
      await saved.close();
    }
  });

  test.each([
    { kind: "profile bytes", reason: "memory-limit", resolved: 0 },
    { kind: "facts bytes", reason: "memory-limit", resolved: 0 },
    { kind: "invalid UTF-8", reason: "memory-storage", resolved: 0 },
    { kind: "symlink", reason: "memory-storage", resolved: 0 },
    { kind: "context bytes", reason: "context-limit", resolved: 1 },
  ])(
    "fails before inference for $kind and preserves the failed run",
    async ({ kind, reason, resolved }) => {
      const saved = await fixture({
        profileBytes: 63,
        factsBytes: 40,
        contextBytes: kind === "context bytes" ? 1 : defaultPolicy.contextBytes,
      });

      try {
        if (kind === "profile bytes") await writeFile(saved.profile, "😀".repeat(16));

        if (kind === "invalid UTF-8") await writeFile(saved.profile, Buffer.from([0xff]));

        if (kind === "symlink") {
          await writeFile(join(saved.directory, "outside.md"), "Not the profile");
          await symlink(join(saved.directory, "outside.md"), saved.profile);
        }

        await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;

            if (kind === "facts bytes")
              yield* store.rememberMemory(
                "long",
                "A preference that exceeds the small serialized facts budget",
              );
            const session = yield* store.createSession("test-provider", "test-model");

            const error = yield* send(session.id).pipe(
              Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
            );

            expect(error).toMatchObject({ reason });
            expect((yield* store.runs(session.id))[0]).toMatchObject({
              status: "failed",
              failureReason: `agent:${reason}`,
            });
          }),
        );
        expect(saved.requests).toEqual([]);
        expect(saved.state.resolved).toBe(resolved);
      } finally {
        await saved.close();
      }
    },
  );
});
