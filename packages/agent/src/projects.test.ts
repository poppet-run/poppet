/* eslint-disable no-await-in-loop -- Each filesystem mutation is checked before the next validation case. */
import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { LocalMemoryLive, Memory } from "@poppet/memory";
import { type ModelRequest, type Output } from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Effect, Layer, Stream } from "effect";

import { Notes, NotesLive } from "#src/notes";
import { Pages } from "#src/pages";
import { Projects, ProjectsLive } from "#src/projects";
import { Agent, AgentLive, ModelResolver } from "#src/service";
import { ChatSettings, defaultPolicy } from "#src/settings";
import { WebSearch } from "#src/web-search";

const fixture = async (contextBytes = defaultPolicy.contextBytes) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-project-"));
  const requests: ModelRequest[] = [];

  const state = {
    resolved: 0,
    output: (_request: ModelRequest): ReadonlyArray<Output> => [{ type: "text", text: "Done" }],
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test",
    model: "model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const settings = Layer.succeed(ChatSettings, { ...defaultPolicy, contextBytes });

  const dependencies = Layer.mergeAll(
    store,
    LocalMemoryLive.pipe(Layer.provide(store)),
    ProjectsLive.pipe(Layer.provide(config)),
    NotesLive.pipe(Layer.provide([config, settings])),
    settings,
    Layer.succeed(Pages, { fetch: () => Effect.die("No page access") }),
    Layer.succeed(WebSearch, { search: null }),
    Layer.succeed(ModelResolver, {
      resolve: () => {
        state.resolved++;

        return Effect.succeed({
          description: {
            provider: "test",
            id: "model",
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
            const output = state.output(request);

            return Stream.make({
              type: "completed" as const,
              response: {
                output,
                continuation: { version: 1 as const, provider: "test", model: "model", data: {} },
                finishReason: output.some((part) => part.type === "tool-call")
                  ? ("tool-calls" as const)
                  : ("stop" as const),
                usage: null,
              },
            });
          },
        });
      },
    }),
  );

  const layer = AgentLive.pipe(Layer.provideMerge(dependencies));
  await mkdir(join(directory, "notes"));

  for (const name of ["acorn", "blue"]) {
    await mkdir(join(directory, "projects", name), { recursive: true });
    await writeFile(join(directory, "projects", name, "PROJECT.md"), `${name} saved instructions`);
  }

  return {
    directory,
    state,
    requests,
    run: <A, E>(program: Effect.Effect<A, E, Agent | Store | Memory | Projects | Notes>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const call = (name: string, namespace: string, args: Record<string, string | null>): Output => ({
  type: "tool-call",
  callId: "call",
  name,
  namespace,
  arguments: JSON.stringify(args),
});

const toolThenDone = (request: ModelRequest, tool: Output): ReadonlyArray<Output> =>
  request.messages.at(-1)?.role === "tool" ? [{ type: "text", text: "Done" }] : [tool];

describe.concurrent("project context boundaries", () => {
  test("rejects oversized project facts before resolution and counts saved instructions in the context budget", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const project = yield* (yield* Projects).load("acorn");
          const memory = (yield* Memory).forProject("acorn");

          for (const key of ["a", "b", "c"]) yield* memory.remember(key, "x".repeat(4096));
          const session = yield* (yield* Store).createSession("test", "model", { project });
          expect(
            yield* Stream.runDrain((yield* Agent).send(session.id, "Review")).pipe(Effect.result),
          ).toMatchObject({
            failure: { reason: "memory-limit", message: expect.stringContaining("8192-byte") },
          });
        }),
      );
      expect(state.state.resolved).toBe(0);
      expect(state.requests).toEqual([]);
    } finally {
      await state.close();
    }

    const small = await fixture(4096);

    try {
      await writeFile(join(small.directory, "projects", "acorn", "PROJECT.md"), "x".repeat(8192));
      await small.run(
        Effect.gen(function* () {
          const project = yield* (yield* Projects).load("acorn");
          const session = yield* (yield* Store).createSession("test", "model", { project });
          expect(
            yield* Stream.runDrain((yield* Agent).send(session.id, "Review")).pipe(Effect.result),
          ).toMatchObject({ failure: { reason: "context-limit" } });
        }),
      );
      expect(small.requests).toEqual([]);
    } finally {
      await small.close();
    }
  });
  test("loads fixed instructions, snapshots current scoped facts once, and binds writes to the run's project", async () => {
    const state = await fixture();
    let id = "";

    try {
      await state.run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* memory.remember("style", "global preference");
          yield* memory.forProject("acorn").remember("style", "acorn preference");
          yield* memory.forProject("blue").remember("style", "blue private preference");
          const project = yield* (yield* Projects).load("acorn");
          const session = yield* (yield* Store).createSession("test", "model", { project });
          id = session.id;
          state.state.output = (request) =>
            toolThenDone(
              request,
              call("memory", "poppet_memory", {
                action: "remember",
                key: "decision",
                value: "new project decision",
              }),
            );
          yield* Stream.runDrain(
            (yield* Agent).send(id, "Remember this decision for this project"),
          );
          expect(yield* memory.list).toHaveLength(1);
          expect(yield* memory.forProject("acorn").list).toMatchObject([
            { key: "decision", value: "new project decision", sourceRunId: expect.any(String) },
            { key: "style", value: "acorn preference" },
          ]);
          expect(yield* memory.forProject("blue").list).toHaveLength(1);
        }),
      );
      expect(state.requests).toHaveLength(2);

      for (const request of state.requests) {
        expect(request.instructions).toContain("global preference");
        expect(request.instructions).toContain("acorn preference");
        expect(request.instructions).not.toContain("blue private preference");
        expect(request.instructions).not.toContain('"value":"new project decision"');
      }

      await rm(join(state.directory, "projects", "acorn"), { recursive: true });
      state.state.output = () => [{ type: "text", text: "Done" }];
      await state.run(
        Effect.gen(function* () {
          yield* Stream.runDrain((yield* Agent).send(id, "Continue after restart"));
        }),
      );
      expect(state.requests.at(-1)?.instructions).toContain("acorn saved instructions");
      expect(state.requests.at(-1)?.instructions).toContain("new project decision");
    } finally {
      await state.close();
    }
  });

  test("scopes model recall for selected and unscoped sessions, while owner inspection can read either", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const projects = yield* Projects;
          const agent = yield* Agent;

          const acorn = yield* store.createSession("test", "model", {
            project: yield* projects.load("acorn"),
          });

          const blue = yield* store.createSession("test", "model", {
            project: yield* projects.load("blue"),
          });

          const global = yield* store.createSession("test", "model");

          for (const session of [acorn, blue, global])
            yield* Stream.runDrain(agent.send(session.id, "needle"));
          expect((yield* store.searchSessions("needle", 16384)).matches).toHaveLength(3);
          expect((yield* store.searchSessions("needle", 16384, "acorn")).matches).toHaveLength(1);
          expect((yield* store.searchSessions("needle", 16384, null)).matches).toHaveLength(1);
          state.state.output = (request) =>
            toolThenDone(request, call("search_sessions", "poppet_history", { query: "needle" }));
          yield* Stream.runDrain(agent.send(acorn.id, "Search"));

          const recalled = state.requests
            .at(-1)
            ?.messages.findLast((message) => message.role === "tool");

          expect(
            recalled?.role === "tool" &&
              JSON.parse(recalled.output).matches.map(
                (match: { sessionId: string }) => match.sessionId,
              ),
          ).toEqual([acorn.id]);
          state.state.output = () => [
            call("read_session", "poppet_history", {
              session_id: blue.id,
              around_message_id: null,
              after_message_id: null,
            }),
          ];

          for (const session of [acorn, global]) {
            const result = yield* Stream.runDrain(agent.send(session.id, "Read that session")).pipe(
              Effect.result,
            );

            expect(result).toMatchObject({ failure: { reason: "not-found" } });
          }

          expect(
            (yield* store.readSession(
              { sessionId: blue.id, aroundMessageId: null, afterMessageId: null },
              16384,
            )).messages,
          ).toHaveLength(2);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("restricts selected note search/read/write without loading other notes, and preserves null versus empty selections", async () => {
    const state = await fixture();

    try {
      await writeFile(join(state.directory, "notes", "selected.md"), "needle selected");
      await writeFile(join(state.directory, "notes", "other.md"), "needle private");
      await writeFile(join(state.directory, "projects", "acorn", "notes.json"), '["selected.md"]');
      await state.run(
        Effect.gen(function* () {
          const project = yield* (yield* Projects).load("acorn");
          const notes = yield* Notes;

          const result = JSON.parse(
            yield* notes.execute({ name: "search_notes", query: "needle" }, project.notes),
          );

          expect(result.matches.map((match: { path: string }) => match.path)).toEqual([
            "selected.md",
          ]);

          for (const name of ["read_note", "save_note"] as const) {
            expect(
              yield* notes
                .execute({ name, path: "other.md", content: "Do not write" }, project.notes)
                .pipe(Effect.result),
            ).toMatchObject({ failure: { reason: "tool-permission" } });
          }

          expect(
            JSON.parse(yield* notes.execute({ name: "search_notes", query: "needle" }, [])).matches,
          ).toEqual([]);
          expect(
            JSON.parse(yield* notes.execute({ name: "search_notes", query: "needle" }, null))
              .matches,
          ).toHaveLength(2);

          const session = yield* (yield* Store).createSession("test", "model", { project });
          state.state.output = (request) =>
            toolThenDone(request, call("search_notes", "poppet_notes", { query: "needle" }));
          yield* Stream.runDrain((yield* Agent).send(session.id, "Search my notes"));

          const response = state.requests
            .at(-1)
            ?.messages.findLast((message) => message.role === "tool");

          expect(
            response?.role === "tool" &&
              JSON.parse(response.output).matches.map((match: { path: string }) => match.path),
          ).toEqual(["selected.md"]);
          state.state.output = (request) =>
            toolThenDone(request, call("read_note", "poppet_notes", { path: "other.md" }));
          yield* Stream.runDrain((yield* Agent).send(session.id, "Read other.md"));
          const store = yield* Store;
          const run = (yield* store.runs(session.id)).at(-1)!;
          expect(run.status).toBe("completed");
          expect(yield* store.toolCalls(run.id)).toMatchObject([
            { status: "failed", failureReason: "agent:tool-permission" },
          ]);
        }),
      );
      await rm(join(state.directory, "notes", "selected.md"));
      await state.run(
        Effect.gen(function* () {
          expect(
            yield* (yield* Notes)
              .execute({ name: "read_note", path: "selected.md" }, ["selected.md"])
              .pipe(Effect.result),
          ).toMatchObject({ failure: { reason: "tool-arguments" } });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects unsafe project files and note selections without inference", async () => {
    const state = await fixture();
    const root = join(state.directory, "projects", "acorn");

    try {
      for (const json of [
        '["../outside.md"]',
        '["/outside.md"]',
        '["same.md","same.md"]',
        JSON.stringify(Array.from({ length: 9 }, (_, index) => `${index}.md`)),
      ]) {
        await writeFile(join(root, "notes.json"), json);
        await expect(
          state.run(Projects.use((projects) => projects.load("acorn"))),
        ).rejects.toThrow();
      }

      await rm(join(root, "notes.json"));
      await writeFile(join(root, "PROJECT.md"), "x".repeat(8193));
      await expect(state.run(Projects.use((projects) => projects.load("acorn")))).rejects.toThrow(
        "8192",
      );
      await rm(join(root, "PROJECT.md"));
      await writeFile(join(state.directory, "outside.md"), "Outside");
      await symlink(join(state.directory, "outside.md"), join(root, "PROJECT.md"));
      await expect(state.run(Projects.use((projects) => projects.load("acorn")))).rejects.toThrow();
      await rm(join(root, "PROJECT.md"));
      await link(join(state.directory, "outside.md"), join(root, "PROJECT.md"));
      await expect(state.run(Projects.use((projects) => projects.load("acorn")))).rejects.toThrow();
      expect(state.requests).toEqual([]);
    } finally {
      await state.close();
    }
  });
});
