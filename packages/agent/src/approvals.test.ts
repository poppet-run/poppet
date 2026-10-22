import { describe, expect, test } from "bun:test";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import { type ModelRequest } from "@poppet/provider";
import {
  ApprovalRepository,
  makeApprovalStore,
  Store,
  StoreDatabase,
  StoreLive,
  type NoteProposal,
} from "@poppet/store";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Approvals, LocalApprovalsLive } from "#src/approvals";
import { AgentError } from "#src/errors";
import { Notes, NotesLive } from "#src/notes";
import { Pages } from "#src/pages";
import { Agent, AgentLive, ModelResolver } from "#src/service";
import { ChatSettings, defaultPolicy } from "#src/settings";
import { WebSearch } from "#src/web-search";

const start = Date.parse("2026-10-22T12:00:00Z");

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-approvals-"));
  const requests: ModelRequest[] = [];

  // SAFETY: the dispatch hook accepts only validated note payloads and typed effects.
  const state = {
    path: "review.md",
    content: "Exact reviewable content",
    tool: "propose_note",
    dispatches: 0,
    dispatch: null as ((payload: NoteProposal) => Effect.Effect<void, AgentError>) | null,
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test",
    model: "model",
  });

  const settings = Layer.succeed(ChatSettings, defaultPolicy);
  const store = StoreLive.pipe(Layer.provideMerge(config));
  const original = NotesLive.pipe(Layer.provide([config, settings]));

  const notes = Layer.effect(
    Notes,
    Effect.gen(function* () {
      const service = yield* Notes;

      return {
        ...service,
        createOnly: (payload: NoteProposal) =>
          Effect.gen(function* () {
            state.dispatches++;

            if (state.dispatch !== null) yield* state.dispatch(payload);

            return yield* service.createOnly!(payload);
          }),
      };
    }),
  ).pipe(Layer.provide(original));

  const approvals = LocalApprovalsLive.pipe(Layer.provideMerge([store, config, settings, notes]));

  const layer = AgentLive.pipe(
    Layer.provideMerge([
      approvals,
      LocalMemoryLive.pipe(Layer.provide(store)),
      Layer.succeed(Pages, { fetch: () => Effect.die("No network") }),
      Layer.succeed(WebSearch, { search: null }),
      Layer.succeed(ModelResolver, {
        resolve: () =>
          Effect.succeed({
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
              const tool = request.messages.at(-1)?.role !== "tool";

              return Stream.make({
                type: "completed" as const,
                response: {
                  output: tool
                    ? [
                        {
                          type: "tool-call" as const,
                          callId: "proposal:one",
                          namespace: "poppet_approvals",
                          name: state.tool,
                          arguments: JSON.stringify({ path: state.path, content: state.content }),
                        },
                      ]
                    : [{ type: "text" as const, text: "Pending owner approval" }],
                  continuation: { version: 1 as const, provider: "test", model: "model", data: {} },
                  finishReason: tool ? ("tool-calls" as const) : ("stop" as const),
                  usage: null,
                },
              });
            },
          }),
      }),
    ]),
  );

  return {
    directory,
    requests,
    state,
    run: <A, E>(
      program: Effect.Effect<
        A,
        E,
        Agent | Approvals | ApprovalRepository | Store | StoreDatabase | Notes
      >,
    ) => Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const propose = Effect.gen(function* () {
  yield* TestClock.setTime(start);
  const store = yield* Store;
  const session = yield* store.createSession("test", "model");
  yield* Stream.runDrain(
    (yield* Agent).send(session.id, "Prepare this note for my review; wait for approval."),
  );

  return (yield* ApprovalRepository).list(start)[0]!;
});

describe.concurrent("owner-reviewed note actions", () => {
  test("proposal content must match the active recorded source call", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("test", "model");

          const run = yield* store.startRun(
            (yield* store.queueRun(session.id, [
              { role: "user", text: "Prepare a review proposal" },
            ])).id,
          );

          yield* store.recordToolCalls(run.id, {
            output: [
              {
                type: "tool-call",
                callId: "source",
                namespace: "poppet_approvals",
                name: "propose_note",
                arguments: '{"path":"review.md","content":"Reviewed arguments"}',
              },
            ],
            finishReason: "tool-calls",
            usage: null,
            continuation: { version: 1, provider: "test", model: "model", data: {} },
          });

          const prepared = yield* (yield* Approvals).prepare(
            { path: "different.md", content: "Unrecorded payload" },
            run.id,
            "source",
            false,
          );

          yield* store.startToolCall(run.id, "source");
          expect(yield* prepared.execute.pipe(Effect.result)).toMatchObject({
            failure: { reason: "tool-arguments" },
          });
          expect((yield* ApprovalRepository).list(0)).toEqual([]);
          expect(state.requests).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });
  test("proposing only saves an immutable complete preview; approval executes once without inference", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const proposal = yield* propose;
          const approvals = yield* Approvals;
          const { database } = yield* StoreDatabase;
          expect(proposal).toMatchObject({
            state: "pending",
            payload: { type: "create_note", path: state.state.path, content: state.state.content },
            expiresAt: start + 86400000,
          });
          expect(
            yield* Effect.promise(() =>
              access(join(state.directory, "notes", "review.md")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          expect(JSON.parse(yield* approvals.command({ action: "show", id: proposal.id }))).toEqual(
            proposal,
          );
          expect(() =>
            database
              .query("UPDATE action_proposals SET payload = '{}' WHERE id = ?")
              .run(proposal.id),
          ).toThrow("immutable");

          const receipt = JSON.parse(
            yield* approvals.command({ action: "approve", id: proposal.id }),
          );

          expect(receipt).toMatchObject({
            state: "completed",
            digest: proposal.digest,
            receipt: { state: "completed", digest: proposal.digest },
          });
          expect(
            JSON.parse(yield* approvals.command({ action: "approve", id: proposal.id })),
          ).toEqual(receipt);
          expect(state.state.dispatches).toBe(1);
          expect(state.requests).toHaveLength(2);
          expect(
            yield* Effect.promise(() =>
              readFile(join(state.directory, "notes", "review.md"), "utf8"),
            ),
          ).toBe(state.state.content);
          expect(() =>
            makeApprovalStore(database, "another-owner").show(proposal.id, start),
          ).toThrow("owner");
          const journal = yield* (yield* Store).toolCalls(proposal.runId);
          expect(JSON.parse(journal[0]!.output!)).toMatchObject({
            status: "pending approval",
            proposal: { id: proposal.id },
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each(["cancel", "expire", "policy", "existing"] as const)(
    "%s prevents dispatch and preserves the target",
    async (mode) => {
      const state = await fixture();

      try {
        await state.run(
          Effect.gen(function* () {
            const proposal = yield* propose;
            const approvals = yield* Approvals;

            if (mode === "cancel") yield* approvals.command({ action: "cancel", id: proposal.id });

            if (mode === "expire") yield* TestClock.adjust("25 hours");

            if (mode === "existing")
              yield* Effect.promise(() =>
                writeFile(join(state.directory, "notes", "review.md"), "Keep existing"),
              );

            if (mode === "policy")
              yield* Effect.promise(async () => {
                await rm(join(state.directory, "notes"), { recursive: true });
                await mkdir(join(state.directory, "replacement"));
                await symlink(join(state.directory, "replacement"), join(state.directory, "notes"));
              });
            expect(
              JSON.parse(yield* approvals.command({ action: "approve", id: proposal.id })).state,
            ).toBe(
              { cancel: "cancelled", expire: "expired", policy: "failed", existing: "failed" }[
                mode
              ],
            );
            expect(state.state.dispatches).toBe(0);

            if (mode === "existing")
              expect(
                yield* Effect.promise(() =>
                  readFile(join(state.directory, "notes", "review.md"), "utf8"),
                ),
              ).toBe("Keep existing");
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("concurrent approvals dispatch once and cancellation cannot undo a claimed execution", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const proposal = yield* propose;
          const approvals = yield* Approvals;
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          state.state.dispatch = () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));

          const first = yield* approvals
            .command({ action: "approve", id: proposal.id })
            .pipe(Effect.forkChild);

          yield* Deferred.await(started);
          expect(
            JSON.parse(yield* approvals.command({ action: "approve", id: proposal.id })).state,
          ).toBe("executing");
          expect(
            JSON.parse(yield* approvals.command({ action: "cancel", id: proposal.id })).state,
          ).toBe("executing");
          yield* Deferred.succeed(release, undefined);
          expect(JSON.parse(yield* Fiber.join(first)).state).toBe("completed");
          expect(state.state.dispatches).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("a competing file creation at dispatch cannot be overwritten and private files are removed", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const proposal = yield* propose;
          state.state.dispatch = () =>
            Effect.promise(() =>
              writeFile(join(state.directory, "notes", "review.md"), "Competing writer", {
                flag: "wx",
              }),
            );
          expect(
            JSON.parse(yield* (yield* Approvals).command({ action: "approve", id: proposal.id }))
              .state,
          ).toBe("failed");
          expect(
            yield* Effect.promise(() =>
              readFile(join(state.directory, "notes", "review.md"), "utf8"),
            ),
          ).toBe("Competing writer");
          expect(yield* Effect.promise(() => readdir(join(state.directory, "notes")))).toEqual([
            "review.md",
          ]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("restart preserves pending work and an executing crash becomes uncertain without dispatch", async () => {
    const state = await fixture();

    try {
      const proposal = await state.run(propose);
      await state.run(
        Effect.gen(function* () {
          const approvals = yield* Approvals;
          expect(
            JSON.parse(yield* approvals.command({ action: "show", id: proposal.id })).state,
          ).toBe("pending");
          expect((yield* ApprovalRepository).claim(proposal.id, start).claimed).toBe(true);
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const receipt = JSON.parse(
            yield* (yield* Approvals).command({ action: "approve", id: proposal.id }),
          );

          expect(receipt.state).toBe("uncertain");
          expect(state.state.dispatches).toBe(0);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("an ambiguous dispatched action stays uncertain and cannot be retried", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const proposal = yield* propose;
          state.state.dispatch = () =>
            Effect.promise(() =>
              writeFile(join(state.directory, "notes", "review.md"), state.state.content),
            ).pipe(
              Effect.andThen(
                Effect.fail(
                  new AgentError({
                    reason: "tool-uncertain",
                    message: "Lost completion after dispatch",
                  }),
                ),
              ),
            );
          const approvals = yield* Approvals;
          const receipt = yield* approvals.command({ action: "approve", id: proposal.id });
          expect(JSON.parse(receipt).state).toBe("uncertain");
          expect(yield* approvals.command({ action: "approve", id: proposal.id })).toBe(receipt);
          expect(state.state.dispatches).toBe(1);
          expect(
            yield* Effect.promise(() =>
              readFile(join(state.directory, "notes", "review.md"), "utf8"),
            ),
          ).toBe(state.state.content);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("oversized previews and failed creation receipts roll back proposals; model approval tools are denied", async () => {
    const state = await fixture();

    try {
      state.state.content = "x".repeat(20000);
      await expect(state.run(propose)).rejects.toThrow("complete proposal preview");
      await state.run(
        Effect.gen(function* () {
          expect((yield* ApprovalRepository).list(start)).toEqual([]);
          const { database } = yield* StoreDatabase;
          database.run(
            "CREATE TEMP TRIGGER reject_proposal_receipt BEFORE UPDATE OF status ON tool_calls WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END;",
          );
          state.state.content = "A small proposal";
          const result = yield* propose.pipe(Effect.result);
          expect(result).toHaveProperty("failure");
          expect((yield* ApprovalRepository).list(start)).toEqual([]);
          database.run("DROP TRIGGER reject_proposal_receipt");
          state.state.tool = "approve";
          expect(yield* propose.pipe(Effect.result)).toMatchObject({
            failure: { reason: "tool-permission" },
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("a failed outcome receipt after publication is recovered as uncertain and never repeated", async () => {
    const state = await fixture();

    try {
      const id = await state.run(
        Effect.gen(function* () {
          const proposal = yield* propose;
          const { database } = yield* StoreDatabase;
          database.run(
            "CREATE TEMP TRIGGER reject_outcome BEFORE UPDATE OF receipt ON action_proposals WHEN OLD.state = 'executing' BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END;",
          );
          expect(
            yield* (yield* Approvals)
              .command({ action: "approve", id: proposal.id })
              .pipe(Effect.result),
          ).toMatchObject({ failure: { reason: "storage" } });
          expect((yield* ApprovalRepository).show(proposal.id, start).state).toBe("executing");

          return proposal.id;
        }),
      );

      await state.run(
        Effect.gen(function* () {
          expect(
            JSON.parse(yield* (yield* Approvals).command({ action: "approve", id })).state,
          ).toBe("uncertain");
          expect(state.state.dispatches).toBe(1);
          expect(
            yield* Effect.promise(() =>
              readFile(join(state.directory, "notes", "review.md"), "utf8"),
            ),
          ).toBe(state.state.content);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("path escapes, linked paths, malformed content and unselected notes cannot become proposals", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const notes = yield* Notes;
          yield* Effect.promise(async () => {
            await mkdir(join(state.directory, "notes"));
            await writeFile(join(state.directory, "outside.md"), "Private");
            await symlink(
              join(state.directory, "outside.md"),
              join(state.directory, "notes", "symlink.md"),
            );
            await link(
              join(state.directory, "outside.md"),
              join(state.directory, "notes", "hardlink.md"),
            );
          });

          for (const path of ["../outside.md", "/outside.md", "symlink.md", "hardlink.md"])
            expect(yield* notes.prepareCreate!(path, "Text").pipe(Effect.result)).toHaveProperty(
              "failure",
            );
          expect(
            yield* notes.prepareCreate!("safe.md", "Text", []).pipe(Effect.result),
          ).toHaveProperty("failure");
          expect(
            yield* notes.prepareCreate!("safe.md", "🙂".repeat(16385)).pipe(Effect.result),
          ).toHaveProperty("failure");
          expect(yield* notes.prepareCreate!("safe.md", "\0").pipe(Effect.result)).toHaveProperty(
            "failure",
          );
        }),
      );
    } finally {
      await state.close();
    }
  });
});
