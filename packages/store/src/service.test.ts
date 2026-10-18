import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { type Completion, type Message, type ProviderId } from "@poppet/provider";
import { Effect, Fiber, Layer } from "effect";

import { StoreError } from "#src/errors";
import { applyMigrations, migrations } from "#src/migrations";
import type { SessionReadResult } from "#src/schema";
import { Store, StoreLive } from "#src/service";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-store-"));
  const path = join(directory, "store/poppet.sqlite");

  const layer = StoreLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "first-provider",
        model: null,
      }),
    ),
  );

  const run = <A>(program: Effect.Effect<A, StoreError, Store>) =>
    Effect.runPromise(program.pipe(Effect.provide(layer)));

  return {
    directory,
    path,
    layer,
    run,
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const responseFor = (provider: ProviderId, text = "Complete"): Completion => ({
  output: [{ type: "text", text }],
  continuation: {
    version: 1,
    provider,
    model: "selected-model",
    data: { protocol: "test", opaque: ["provider-continuation", { signature: "preserve" }] },
  },
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 2 },
});

const user: Message = { role: "user", text: "Hello" };

const reject = <A>(operation: Effect.Effect<A, StoreError>, reason: StoreError["reason"]) =>
  operation.pipe(
    Effect.match({
      onFailure: (error) => expect(error.reason).toBe(reason),
      onSuccess: () => {
        throw new Error("Expected rejection");
      },
    }),
  );

// Durable SQLite writes run sequentially to avoid disk contention on CI runners.
describe("conversation store", () => {
  test("indexes only completed user text and final answers, retaining titles and results across restart", async () => {
    const saved = await fixture();

    try {
      const savedSession = await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("new-provider", "selected-model");

          const run = yield* store.queueRun(session.id, [
            { role: "user", text: "Orchard café 東京" },
          ]);

          yield* store.startRun(run.id);
          expect((yield* store.searchSessions("Orchard", 16384)).matches).toEqual([]);
          expect(
            (yield* store.readSession(
              { sessionId: session.id, aroundMessageId: null, afterMessageId: null },
              16384,
            )).messages,
          ).toEqual([]);
          yield* store.recordToolCalls(run.id, {
            ...responseFor("new-provider"),
            output: [
              { type: "text", text: "intermediateonly" },
              {
                type: "tool-call",
                callId: "read",
                name: "read_note",
                namespace: "poppet_notes",
                arguments: '{"path":"argumentonly.md"}',
              },
            ],
            finishReason: "tool-calls",
          });
          yield* store.startToolCall(run.id, "read");
          yield* store.finishToolCall(run.id, "read", { status: "completed", output: "toolonly" });
          yield* store.finishRun(run.id, {
            status: "completed",
            response: {
              ...responseFor("new-provider"),
              output: [
                { type: "text", text: "Final résumé" },
                { type: "text", text: "Orchard answer" },
              ],
            },
          });
          yield* store.renameSession(session.id, "The orchard");
          const matches = yield* store.searchSessions("Orchard", 16384);
          expect(matches).toMatchObject({
            truncated: false,
            matches: [
              {
                sessionId: session.id,
                title: "The orchard",
                role: "user",
                excerpt: "Orchard café 東京",
              },
              {
                sessionId: session.id,
                title: "The orchard",
                role: "assistant",
                excerpt: "Final résumé\nOrchard answer",
              },
            ],
          });
          expect(
            matches.matches.every(
              (entry) => entry.messageId > 0 && entry.createdAt >= session.createdAt,
            ),
          ).toBe(true);

          for (const query of [
            "intermediateonly",
            "argumentonly",
            "toolonly",
            "provider-continuation",
            "preserve",
          ]) {
            expect((yield* store.searchSessions(query, 16384)).matches).toEqual([]);
          }

          const failed = yield* store.queueRun(session.id, [{ role: "user", text: "failedonly" }]);
          yield* store.finishRun(failed.id, { status: "failed", reason: "test" });

          const interrupted = yield* store.queueRun(session.id, [
            { role: "user", text: "interruptedonly" },
          ]);

          yield* store.finishRun(interrupted.id, { status: "interrupted", reason: "test" });
          yield* store.appendMessages({
            sessionId: session.id,
            runId: null,
            messages: [{ role: "user", text: "unownedonly" }],
          });

          for (const query of ["failedonly", "interruptedonly", "unownedonly"]) {
            expect((yield* store.searchSessions(query, 16384)).matches).toEqual([]);
          }

          const history = yield* store.messages(session.id);
          const metadata = yield* store.session(session.id);
          const read = { sessionId: session.id, aroundMessageId: null, afterMessageId: null };
          const recalled = yield* store.readSession(read, 16384);
          expect(recalled).toEqual({
            sessionId: session.id,
            title: "The orchard",
            messages: matches.matches.map(({ messageId, role, createdAt, excerpt }) => ({
              messageId,
              role,
              createdAt,
              text: excerpt,
              truncated: false,
            })),
            nextAfterMessageId: null,
            truncated: false,
          });

          for (const entry of history) {
            if (recalled.messages.some((message) => message.messageId === entry.id)) continue;
            yield* reject(
              store.readSession({ ...read, aroundMessageId: entry.id }, 16384),
              "invalid-request",
            );
            yield* reject(
              store.readSession({ ...read, afterMessageId: entry.id }, 16384),
              "invalid-request",
            );
          }

          expect(yield* store.messages(session.id)).toEqual(history);
          expect(yield* store.session(session.id)).toEqual(metadata);

          return session;
        }),
      );

      await saved.run(
        Store.use((store) =>
          Effect.gen(function* () {
            const result = yield* store.searchSessions("東京", 16384);
            expect(result.matches).toMatchObject([
              { sessionId: savedSession.id, title: "The orchard", role: "user" },
            ]);
            expect((yield* store.searchSessions("résumé", 16384)).matches).toHaveLength(1);
          }),
        ),
      );
    } finally {
      await saved.close();
    }
  });

  test("pages in session order around stable matches and past appended exchanges, validating session anchors", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Store.use((store) =>
          Effect.gen(function* () {
            const session = yield* store.createSession("new-provider", "selected-model");
            const empty = yield* store.createSession("new-provider", "selected-model");
            const query = { sessionId: session.id, aroundMessageId: null, afterMessageId: null };
            expect(yield* store.readSession({ ...query, sessionId: empty.id }, 1024)).toMatchObject(
              {
                title: empty.title,
                messages: [],
                truncated: false,
                nextAfterMessageId: null,
              },
            );

            const complete = (number: number) =>
              Effect.gen(function* () {
                const run = yield* store.queueRun(session.id, [
                  { role: "user", text: `Question ${number}` },
                ]);

                yield* store.startRun(run.id);
                yield* store.finishRun(run.id, {
                  status: "completed",
                  response: responseFor("new-provider", `Answer ${number}`),
                });
              });

            for (let number = 0; number < 20; number++) yield* complete(number);
            const history = yield* store.messages(session.id);
            const first = yield* store.readSession(query, 16384);
            expect(first.messages.map((message) => message.messageId)).toEqual(
              history.slice(0, 10).map((message) => message.id),
            );
            expect(first).toMatchObject({ truncated: true, nextAfterMessageId: history[9]!.id });

            const around = yield* store.readSession(
              { ...query, aroundMessageId: history[12]!.id },
              16384,
            );

            expect(around.messages.map((message) => message.messageId)).toEqual(
              history.slice(8, 18).map((message) => message.id),
            );
            expect(around).toMatchObject({ truncated: true, nextAfterMessageId: history[17]!.id });
            yield* complete(20);
            const ids = first.messages.map((message) => message.messageId);
            let cursor = first.nextAfterMessageId;

            while (cursor !== null) {
              const page = yield* store.readSession({ ...query, afterMessageId: cursor }, 16384);
              ids.push(...page.messages.map((message) => message.messageId));
              cursor = page.nextAfterMessageId;
            }

            expect(ids).toEqual((yield* store.messages(session.id)).map((message) => message.id));
            expect(
              yield* store.readSession({ ...query, afterMessageId: ids.at(-1)! }, 1024),
            ).toMatchObject({ messages: [], nextAfterMessageId: null, truncated: false });
            yield* reject(store.readSession({ ...query, sessionId: "missing" }, 1024), "not-found");

            for (const invalid of [
              { ...query, sessionId: empty.id, aroundMessageId: ids[0]! },
              { ...query, aroundMessageId: 999999 },
              { ...query, aroundMessageId: ids[0]!, afterMessageId: ids[1]! },
              { ...query, afterMessageId: -1 },
            ])
              yield* reject(store.readSession(invalid, 1024), "invalid-request");
            yield* reject(store.readSession(query, 100), "invalid-request");
          }),
        ),
      );
    } finally {
      await saved.close();
    }
  });

  test.each([1024, 16384, 65536])(
    "bounds recall to %s bytes without splitting Unicode or trapping oversized messages",
    async (maxBytes) => {
      const saved = await fixture();

      try {
        await saved.run(
          Store.use((store) =>
            Effect.gen(function* () {
              const session = yield* store.createSession("new-provider", "selected-model", {
                id: "s".repeat(128),
              });

              yield* store.renameSession(session.id, "🙂".repeat(80));
              const texts = ['🙂東京\n"\t'.repeat(20000), "before\0after", "Final discussion"];

              for (let index = 0; index < 7; index++) {
                const run = yield* store.queueRun(session.id, [
                  { role: "user", text: texts[index % 3]! },
                ]);

                yield* store.startRun(run.id);
                yield* store.finishRun(run.id, {
                  status: "completed",
                  response: responseFor("new-provider", texts[(index + 1) % 3]!),
                });
              }

              const history = yield* store.messages(session.id);
              const query = { sessionId: session.id, aroundMessageId: null, afterMessageId: null };
              let cursor: number | null = null;
              const ids: number[] = [];

              do {
                const page: SessionReadResult = yield* store.readSession(
                  { ...query, afterMessageId: cursor },
                  maxBytes,
                );

                expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maxBytes);
                expect(page.messages.length).toBeGreaterThan(0);
                expect(page.messages.length).toBeLessThanOrEqual(10);

                for (const message of page.messages) {
                  const original = history.find((entry) => entry.id === message.messageId)!.message;

                  if (original.role === "tool") throw new Error("Recalled a tool result");

                  const text =
                    original.role === "user"
                      ? original.text
                      : original.output
                          .flatMap((part) => (part.type === "text" ? [part.text] : []))
                          .join("\n");

                  expect(text.startsWith(message.text)).toBe(true);
                  expect(message.text.isWellFormed()).toBe(true);
                  expect(message.truncated).toBe(message.text !== text);
                }

                expect(page.truncated).toBe(
                  page.nextAfterMessageId !== null ||
                    page.messages.some((message) => message.truncated),
                );
                ids.push(...page.messages.map((message) => message.messageId));
                cursor = page.nextAfterMessageId;
              } while (cursor !== null);

              expect(ids).toEqual(history.map((message) => message.id));
              const match = history[8]!.id;

              const around = yield* store.readSession(
                { ...query, aroundMessageId: match },
                maxBytes,
              );

              expect(around.messages.some((message) => message.messageId === match)).toBe(true);
              expect(Buffer.byteLength(JSON.stringify(around))).toBeLessThanOrEqual(maxBytes);
              expect(around.truncated).toBe(true);
            }),
          ),
        );
      } finally {
        await saved.close();
      }
    },
  );

  test("treats queries as plain text and bounds ranked results, UTF-8 excerpts and serialized bytes", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Store.use((store) =>
          Effect.gen(function* () {
            const session = yield* store.createSession("new-provider", "selected-model");

            const complete = (text: string) =>
              Effect.gen(function* () {
                const run = yield* store.queueRun(session.id, [{ role: "user", text }]);
                yield* store.startRun(run.id);
                yield* store.finishRun(run.id, {
                  status: "completed",
                  response: responseFor("new-provider", "Final"),
                });
              });

            yield* complete('alpha & beta OR café 東京 C++ foo-bar quote"word');

            for (const query of [
              "alpha OR beta",
              "alpha & beta",
              "alpha / beta",
              '" OR * - :',
              "C++",
              "foo-bar",
              'quote"word',
              "café",
              "東京",
            ]) {
              expect((yield* store.searchSessions(query, 16384)).matches).toHaveLength(1);
            }

            for (const query of [
              "alpha OR absent",
              '& / " * - :',
              "...",
              "missing",
              "text:alpha",
              "alph*",
            ]) {
              const result = yield* store.searchSessions(query, 16384);
              expect(result.matches).toEqual([]);
            }

            for (const query of ["", " ", " leading", "x".repeat(257)]) {
              yield* reject(store.searchSessions(query, 16384), "invalid-request");
            }

            for (let index = 0; index < 12; index++) yield* complete("equalrank");
            const first = yield* store.searchSessions("equalrank", 16384);
            expect(first.matches).toHaveLength(10);
            expect(first.truncated).toBe(true);
            expect(first.matches.map((match) => match.messageId)).toEqual(
              first.matches.map((match) => match.messageId).toSorted((a, b) => a - b),
            );
            expect(yield* store.searchSessions("equalrank", 16384)).toEqual(first);
            const small = yield* store.searchSessions("equalrank", 1024);
            expect(small.truncated).toBe(true);
            expect(small.matches.length).toBeGreaterThan(0);
            expect(small.matches.every((match) => match.excerpt.includes("equalrank"))).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(1024);
            yield* complete("needle " + "🙂".repeat(5000));
            const bounded = yield* store.searchSessions("needle", 1024);
            expect(bounded.matches).toHaveLength(1);
            expect(bounded.truncated).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(1024);
            expect(bounded.matches[0]?.excerpt).toContain("needle");
            expect(bounded.matches[0]?.excerpt).not.toContain("\ufffd");
            yield* complete("nebula " + "padding ".repeat(100));
            yield* complete("nebula");
            expect(
              (yield* store.searchSessions("nebula", 16384)).matches.map((match) => match.excerpt),
            ).toMatchObject(["nebula", expect.any(String)]);
          }),
        ),
      );
    } finally {
      await saved.close();
    }
  });

  test.each([
    {
      text: "https://example.test/" + "x".repeat(1200) + " timeout",
      query: "timeout",
      maxBytes: 16384,
    },
    {
      text: "implementation ".repeat(47) + "cobalt",
      query: "cobalt",
      maxBytes: 1024,
    },
    {
      text: "🙂".repeat(1200) + " CAFÉ " + "padding ".repeat(30),
      query: "cafe",
      matched: "CAFÉ",
      maxBytes: 1024,
    },
  ])("keeps matching text in shortened excerpts within $maxBytes bytes", async (input) => {
    const saved = await fixture();

    try {
      await saved.run(
        Store.use((store) =>
          Effect.gen(function* () {
            const session = yield* store.createSession("new-provider", "selected-model");
            yield* store.renameSession(session.id, "設".repeat(80));
            const run = yield* store.queueRun(session.id, [{ role: "user", text: input.text }]);
            yield* store.startRun(run.id);
            yield* store.finishRun(run.id, {
              status: "completed",
              response: responseFor("new-provider"),
            });

            const result = yield* store.searchSessions(input.query, input.maxBytes);
            expect(result.matches).toHaveLength(1);
            const excerpt = result.matches[0]!.excerpt;
            expect(excerpt).toContain(input.matched ?? input.query);
            expect(input.text).toContain(excerpt);
            expect([...excerpt].length).toBeLessThanOrEqual(1000);
            expect(excerpt).not.toContain("\ufffd");
            expect(result.truncated).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(input.maxBytes);
          }),
        ),
      );
    } finally {
      await saved.close();
    }
  });

  test("an indexing failure rolls back the completed run and final message", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Store.use((store) =>
          Effect.gen(function* () {
            const session = yield* store.createSession("new-provider", "selected-model");
            const run = yield* store.queueRun(session.id, [{ role: "user", text: "recoverable" }]);
            yield* store.startRun(run.id);
            using injected = new Database(saved.path);
            injected.run("DROP TABLE session_search");
            yield* reject(
              store.finishRun(run.id, {
                status: "completed",
                response: responseFor("new-provider"),
              }),
              "storage",
            );
            expect((yield* store.run(run.id))?.status).toBe("running");
            expect((yield* store.messages(session.id)).map((entry) => entry.message.role)).toEqual([
              "user",
            ]);
            injected.run("CREATE VIRTUAL TABLE session_search USING fts5(text)");
            yield* store.finishRun(run.id, {
              status: "completed",
              response: responseFor("new-provider"),
            });
            expect((yield* store.searchSessions("recoverable", 16384)).matches).toHaveLength(1);
          }),
        ),
      );
    } finally {
      await saved.close();
    }
  });

  test.each(["pending", "running"])(
    "recovers abandoned %s tool calls without replaying them",
    async (state) => {
      const fixtureStore = await fixture();

      try {
        const run = await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("new-provider", "selected-model");
            const pending = yield* store.queueRun(session.id, [user]);
            yield* store.startRun(pending.id);
            yield* store.recordToolCalls(pending.id, {
              ...responseFor("new-provider"),
              finishReason: "tool-calls",
              output: [
                {
                  type: "tool-call",
                  callId: "write",
                  name: "save_note",
                  namespace: "notes",
                  arguments: '{"path":"a.md","content":"May already exist"}',
                },
                {
                  type: "tool-call",
                  callId: "read",
                  name: "read_note",
                  namespace: "notes",
                  arguments: '{"path":"a.md"}',
                },
              ],
            });

            if (state === "running") yield* store.startToolCall(pending.id, "write");

            return pending;
          }),
        );

        await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            expect(yield* store.run(run.id)).toMatchObject({
              status: "interrupted",
              failureReason: "process-exit",
            });
            expect(yield* store.toolCalls(run.id)).toEqual([
              expect.objectContaining({
                callId: "write",
                status: state === "running" ? "uncertain" : "interrupted",
                failureReason: "process-exit",
                output: null,
              }),
              expect.objectContaining({
                callId: "read",
                status: "interrupted",
                failureReason: "process-exit",
                output: null,
              }),
            ]);
            yield* reject(store.startToolCall(run.id, "write"), "conflict");
            expect(
              (yield* store.messages(run.sessionId)).map((entry) => entry.message.role),
            ).toEqual(["user", "assistant"]);
          }),
        );
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("persists messages, tools, continuation and completed runs across reopening", async () => {
    const provider = "new-provider";
    const fixtureStore = await fixture();

    try {
      const response = responseFor(provider);

      const exchange: ReadonlyArray<Message> = [
        {
          role: "assistant",
          output: [
            {
              type: "tool-call",
              callId: "call-1",
              name: "read_note",
              namespace: "notes",
              arguments: '{"path":"test.md"}',
            },
          ],
          continuation: response.continuation,
        },
        { role: "tool", callId: "call-1", output: "A note" },
      ];

      const saved = await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;

          const session = yield* store.createSession(provider, "selected-model", {
            workload: "coding",
          });

          const pending = yield* store.queueRun(session.id, [user]);
          expect(pending).toMatchObject({
            status: "pending",
            provider,
            model: "selected-model",
            workload: "coding",
            startedAt: null,
            result: null,
          });
          const running = yield* store.startRun(pending.id);
          expect(running.status).toBe("running");
          yield* store.appendMessages({
            sessionId: session.id,
            runId: pending.id,
            messages: exchange,
          });
          const completed = yield* store.finishRun(pending.id, { status: "completed", response });

          return { session, completed };
        }),
      );

      await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;
          expect(yield* store.session(saved.session.id)).toMatchObject({
            provider,
            model: "selected-model",
            workload: "coding",
          });
          expect(yield* store.run(saved.completed.id)).toEqual(saved.completed);
          expect(yield* store.runs(saved.session.id)).toEqual([saved.completed]);
          const messages = yield* store.messages(saved.session.id);
          expect(messages.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
          expect(messages.every((entry) => entry.runId === saved.completed.id)).toBe(true);
          expect(messages.map((entry) => entry.message)).toEqual([
            user,
            ...exchange,
            { role: "assistant", output: response.output, continuation: response.continuation },
          ]);
          expect(yield* store.status).toMatchObject({
            schemaVersion: 14,
            sessions: 1,
            messages: 4,
            runs: 1,
          });
        }),
      );
      expect((await stat(join(fixtureStore.directory, "store"))).mode & 0o777).toBe(0o700);
      expect((await stat(fixtureStore.path)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
    } finally {
      await fixtureStore.close();
    }
  });

  test("rolls back partial input and completion writes when SQLite rejects a later operation", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("new-provider", "selected-model");
          using injected = new Database(fixtureStore.path);
          injected.run(
            `CREATE TRIGGER reject_second_message BEFORE INSERT ON messages WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'secret-sql-failure'); END`,
          );

          const failure = yield* store
            .queueRun(session.id, [user, user])
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

          expect(failure).toMatchObject({ reason: "storage" });
          expect(JSON.stringify(failure)).not.toContain("secret-sql-failure");
          expect(yield* store.status).toMatchObject({ messages: 0, runs: 0 });
          expect(yield* store.session(session.id)).toEqual(session);
          injected.run("DROP TRIGGER reject_second_message");
          const run = yield* store.queueRun(session.id, [user]);
          yield* store.startRun(run.id);
          injected.run(
            `CREATE TRIGGER reject_completion BEFORE UPDATE ON runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'secret-sql-failure'); END`,
          );

          const failedCompletion = yield* store
            .finishRun(run.id, { status: "completed", response: responseFor("new-provider") })
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

          expect(failedCompletion).toMatchObject({ reason: "storage" });
          expect(yield* store.run(run.id)).toMatchObject({ status: "running", result: null });
          expect((yield* store.messages(session.id)).map((entry) => entry.message)).toEqual([user]);
          injected.run("DROP TRIGGER reject_completion");
          expect(
            (yield* store.finishRun(run.id, {
              status: "completed",
              response: responseFor("new-provider"),
            })).status,
          ).toBe("completed");
        }),
      );
    } finally {
      await fixtureStore.close();
    }
  });

  test("enforces one active run, session ownership, continuation identity and terminal transitions", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.createSession("new-provider", "selected-model");
          const other = yield* store.createSession("second-provider", "selected-model");

          const foreign: Message = {
            role: "assistant",
            output: [],
            continuation: responseFor("second-provider").continuation,
          };

          yield* reject(store.queueRun(first.id, [foreign]), "invalid-request");
          expect(yield* store.status).toMatchObject({ runs: 0, messages: 0 });
          const pending = yield* store.queueRun(first.id, [user]);
          yield* reject(store.queueRun(other.id, [user]), "conflict");
          yield* reject(
            store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("new-provider"),
            }),
            "conflict",
          );
          yield* reject(
            store.appendMessages({ sessionId: first.id, runId: null, messages: [user] }),
            "conflict",
          );
          yield* store.startRun(pending.id);
          yield* reject(store.startRun(pending.id), "conflict");
          yield* reject(
            store.appendMessages({ sessionId: other.id, runId: pending.id, messages: [user] }),
            "conflict",
          );
          yield* reject(
            store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("second-provider"),
            }),
            "invalid-request",
          );

          const failed = yield* store.finishRun(pending.id, {
            status: "failed",
            reason: "quota",
          });

          expect(failed).toMatchObject({ status: "failed", failureReason: "quota", result: null });
          yield* reject(
            store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("new-provider"),
            }),
            "conflict",
          );
          yield* reject(
            store.appendMessages({ sessionId: first.id, runId: pending.id, messages: [user] }),
            "conflict",
          );
          const next = yield* store.queueRun(other.id, [user]);
          expect(next.status).toBe("pending");
        }),
      );
    } finally {
      await fixtureStore.close();
    }
  });

  test.each(["pending", "running"])(
    "marks an abandoned %s run interrupted on reopening without replay",
    async (state) => {
      const fixtureStore = await fixture();

      try {
        const before = await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("new-provider", "selected-model");
            const run = yield* store.queueRun(session.id, [user]);

            if (state === "running") yield* store.startRun(run.id);

            return run;
          }),
        );

        await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const abandoned = yield* store.run(before.id);
            expect(abandoned).toMatchObject({
              status: "interrupted",
              failureReason: "process-exit",
              result: null,
            });
            expect(abandoned?.finishedAt).not.toBeNull();
            expect((yield* store.messages(before.sessionId)).map((entry) => entry.message)).toEqual(
              [user],
            );
            expect((yield* store.queueRun(before.sessionId, [user])).id).not.toBe(before.id);
          }),
        );
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("rejects another owner and closes the database and lock on interruption", async () => {
    const fixtureStore = await fixture();
    const opened = Promise.withResolvers<Store["Service"]>();

    const owner = Effect.runFork(
      Effect.gen(function* () {
        const store = yield* Store;
        opened.resolve(store);
        yield* Effect.never;
      }).pipe(Effect.provide(fixtureStore.layer)),
    );

    try {
      const borrowed = await opened.promise;
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "busy",
      });
      await Effect.runPromise(Fiber.interrupt(owner));
      await expect(Effect.runPromise(borrowed.status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      expect(await fixtureStore.run(Store.use((store) => store.status))).toMatchObject({
        schemaVersion: 14,
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(owner));
      await fixtureStore.close();
    }
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    "upgrades schema %s while retaining session history and existing or default workloads",
    async (version) => {
      const fixtureStore = await fixture();

      try {
        await mkdir(join(fixtureStore.directory, "store"));
        using old = new Database(fixtureStore.path);
        old.run("PRAGMA foreign_keys = ON");
        applyMigrations(old, migrations.slice(0, version));
        old
          .query(
            "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("old-session", "new-provider", "selected-model", 1, 1);
        old
          .query(
            "INSERT INTO runs (id, session_id, provider, model, status, created_at) VALUES (?, ?, ?, ?, 'pending', 1)",
          )
          .run("old-run", "old-session", "new-provider", "selected-model");
        const workload = version >= 3 ? "coding" : "assistant";

        if (version >= 3) {
          old.run("UPDATE sessions SET workload = 'coding'");
          old.run("UPDATE runs SET workload = 'coding'");
        }

        old
          .query(
            "INSERT INTO messages (session_id, position, created_at, payload) VALUES (?, ?, ?, ?)",
          )
          .run("old-session", 0, 1, JSON.stringify(user));
        old.close(true);
        await fixtureStore.run(
          Store.use((store) =>
            Effect.gen(function* () {
              expect((yield* store.status).schemaVersion).toBe(14);
              expect((yield* store.messages("old-session"))[0]?.message).toEqual(user);
              expect(yield* store.session("old-session")).toMatchObject({
                workload,
                title: null,
                titleSource: null,
                titleAttempted: false,
                titleUsage: null,
                skill: null,
              });
              expect(yield* store.claimTitle("old-session")).toBeNull();
              expect(yield* store.run("old-run")).toMatchObject({
                status: "interrupted",
                workload,
                failureReason: "process-exit",
              });
              expect(yield* store.queueRun("old-session", [user])).toMatchObject({
                provider: "new-provider",
                workload,
              });
            }),
          ),
        );
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test.each(["workload", "continuation"])(
    "rejects a run's foreign %s through both single and session reads",
    async (kind) => {
      const saved = await fixture();

      try {
        const run = await saved.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("new-provider", "selected-model");
            const pending = yield* store.queueRun(session.id, [user]);
            yield* store.startRun(pending.id);

            return yield* store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("new-provider"),
            });
          }),
        );

        using tampered = new Database(saved.path);

        if (kind === "workload")
          tampered.query("UPDATE runs SET workload = 'coding' WHERE id = ?").run(run.id);
        else
          tampered
            .query("UPDATE runs SET result = ? WHERE id = ?")
            .run(JSON.stringify(responseFor("other-provider")), run.id);

        tampered.close(true);

        await saved.run(
          Store.use((store) =>
            Effect.gen(function* () {
              yield* reject(store.run(run.id), "corrupt");
              yield* reject(store.runs(run.sessionId), "corrupt");
            }),
          ),
        );
      } finally {
        await saved.close();
      }
    },
  );

  test.each(["malformed-json", "foreign-continuation"])(
    "rejects %s rows without exposing payloads",
    async (kind) => {
      const fixtureStore = await fixture();

      try {
        const session = await fixtureStore.run(
          Store.use((store) => store.createSession("new-provider", "selected-model")),
        );

        using tampered = new Database(fixtureStore.path);
        tampered
          .query(
            "INSERT INTO messages (session_id, position, created_at, payload) VALUES (?, ?, ?, ?)",
          )
          .run(
            session.id,
            0,
            1,
            kind === "malformed-json"
              ? "secret-invalid-payload"
              : JSON.stringify({
                  role: "assistant",
                  output: [],
                  continuation: responseFor("second-provider").continuation,
                }),
          );
        tampered.close(true);

        const failure = await fixtureStore.run(
          Store.use((store) =>
            store
              .messages(session.id)
              .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
          ),
        );

        expect(failure).toMatchObject({ reason: "corrupt" });
        expect(JSON.stringify(failure)).not.toContain("secret-invalid-payload");
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("releases ownership after initialization fails and rejects database symlinks", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(Store.use((store) => store.status));
      await writeFile(fixtureStore.path, "invalid-database");
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "storage",
      });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      await rm(fixtureStore.path);
      const target = join(fixtureStore.directory, "unrelated");
      await writeFile(target, "do not change", { mode: 0o644 });
      await symlink(target, fixtureStore.path);
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "storage",
      });
      expect((await stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await fixtureStore.close();
    }
  });

  test("releases ownership when a newer database schema prevents startup", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(Store.use((store) => store.status));
      using newer = new Database(fixtureStore.path);
      newer.run("PRAGMA user_version = 99");
      newer.close(true);
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "migration",
      });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      using inspect = new Database(fixtureStore.path, { readonly: true });
      expect(inspect.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    } finally {
      await fixtureStore.close();
    }
  });
});
