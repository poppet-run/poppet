import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Agent,
  AgentLive,
  Bash,
  ChatSettings,
  defaultPolicy,
  type ChatPolicy,
  ModelResolver,
  Pages,
  WebSearch,
  Skills,
  SkillsLive,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import { ProviderError, type ModelOperations, type ModelRequest } from "@poppet/provider";
import { DeliveryDestination, Store, StoreDatabase, StoreLive } from "@poppet/store";
import {
  ChatTasksLive,
  TaskRepository,
  TaskRepositoryLive,
  TaskDestinations,
  executeTaskCommand,
  executeOccurrence,
} from "@poppet/tasks";
import { Console, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { AttachmentProcessorLive } from "#src/attachments";
import { ChannelError, MessagingChannel, type IncomingMessage } from "#src/channel";
import { GatewayRepository, GatewayRepositoryLive } from "#src/repository";
import { Gateway, GatewayLive, chunks } from "#src/service";

const quietConsole: Console.Console = { ...console, log: () => undefined, error: () => undefined };

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
  tools = false,
  policy: Partial<ChatPolicy> = {},
  pages: Pages["Service"] = { fetch: () => Effect.die("Unexpected page fetch") },
  bash?: Bash["Service"],
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
    destination: () => Effect.succeed("parent"),
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
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const settings = Layer.succeed(ChatSettings, { ...defaultPolicy, ...policy });
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store));
  const skills = SkillsLive.pipe(Layer.provide(config));

  const agent = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        LocalMemoryLive.pipe(Layer.provide(store)),
        settings,
        ChatTasksLive.pipe(Layer.provide([tasks, store, skills, settings])),
        Layer.succeed(WebSearch, { search: null }),
        Layer.succeed(Pages, pages),
        bash === undefined ? Layer.empty : Layer.succeed(Bash, bash),
        Layer.succeed(ModelResolver, {
          resolve: (provider, model) => {
            expect([provider, model]).toEqual(["test-provider", "test-model"]);

            return Effect.succeed({
              description: {
                provider,
                id: model,
                name: "Test",
                capabilities: {
                  tools,
                  generationSettings: [],
                  contextWindow: null,
                  maxOutputTokens: null,
                },
              },
              stream: (request) => {
                requests.push(request);
                const last = request.messages.at(-1);

                // Like a model answering with the failure, end the loop after a reported tool error.
                return last?.role === "tool" && last.output.startsWith('{"error":')
                  ? response()
                  : stream(request);
              },
            });
          },
        }),
      ),
    ),
  );

  const layer = GatewayLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        channel,
        GatewayRepositoryLive.pipe(Layer.provideMerge(store)),
        tasks,
        skills,
        agent,
        AttachmentProcessorLive,
      ),
    ),
  );

  return {
    directory,
    sent,
    marks,
    requests,
    run: <A, E>(
      program: Effect.Effect<
        A,
        E,
        Gateway | Store | StoreDatabase | GatewayRepository | TaskRepository | Agent | Skills
      >,
    ) =>
      Effect.runPromise(
        program.pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Console.Console, quietConsole),
        ),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const scheduled = (destination: DeliveryDestination | null) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepository;
    repo.add(
      {
        name: "Summary",
        prompt: "Summarize recent conversations",
        provider: "test-provider",
        model: "test-model",
        workload: "assistant",
        schedule: { type: "once", at: 0 },
      },
      0,
      null,
      destination,
    );
    repo.reconcile(0);
    const claimed = repo.claim(0)!;
    yield* executeOccurrence(repo, claimed.occurrence, claimed.task);

    return repo.occurrence(claimed.occurrence.id);
  });

describe.concurrent("Gateway", () => {
  test.each(["approve", "deny", "timeout", "cancel", "revoked"])(
    "when command approval ends with %s, binds the decision to the owner and original conversation",
    async (action) => {
      const requested = Effect.runSync(Deferred.make<string>());
      let executed = 0;
      let revoked = false;

      const state = await fixture(
        {
          checkAccess: (input) =>
            Effect.suspend(() => {
              if (revoked)
                return Effect.fail(new ChannelError({ reason: "permission", message: "Revoked" }));

              if (action === "revoked" && input.messageId === "decision") revoked = true;

              return Effect.void;
            }),
          send: (_conversation, text) =>
            Effect.gen(function* () {
              const id = /Reply \/approve ([a-f0-9-]{36})/.exec(text)?.[1];

              if (id) yield* Deferred.succeed(requested, id);

              return "sent";
            }),
        },
        (request) => {
          if (request.settings.toolChoice === "none")
            return response(
              JSON.stringify({ decision: "needs_approval", reason: "Restart a service" }),
            );

          if (request.messages.at(-1)?.role === "tool") return response("Done");

          return Stream.make({
            type: "completed",
            response: {
              output: [
                {
                  type: "tool-call",
                  namespace: "poppet_system",
                  name: "bash",
                  callId: "bash-1",
                  arguments: JSON.stringify({
                    command: "restart-service",
                    cwd: "/tmp",
                    timeoutSeconds: 5,
                  }),
                },
              ],
              continuation: {
                version: 1,
                provider: "test-provider",
                model: "test-model",
                data: {},
              },
              finishReason: "tool-calls",
              usage: null,
            },
          });
        },
        true,
        {},
        undefined,
        {
          run: () =>
            Effect.sync(() => {
              executed++;

              return { stdout: "done", stderr: "", exitCode: 0, truncated: false };
            }),
        },
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.accept(message("start", "thread", "Restart the service"));
            const running = yield* gateway.processNext.pipe(Effect.forkChild);
            const id = yield* Deferred.await(requested);
            yield* gateway.accept({
              ...message("stranger", "thread", `/approve ${id}`),
              senderId: "stranger",
            });
            yield* gateway.accept(message("other", "other-thread", `/approve ${id}`));
            expect(executed).toBe(0);

            if (action === "timeout") yield* TestClock.adjust("2 minutes");
            else
              yield* gateway.accept(
                message(
                  "decision",
                  "thread",
                  action === "cancel"
                    ? "/cancel"
                    : `/${action === "revoked" ? "approve" : action} ${id}`,
                ),
              );
            yield* Fiber.join(running);
            expect(executed).toBe(action === "approve" ? 1 : 0);
            revoked = false;
            yield* gateway.accept(message("replay", "thread", `/approve ${id}`));
            expect(yield* gateway.processNext).toBe(false);
            expect(executed).toBe(action === "approve" ? 1 : 0);
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when cron needs command approval, fails without executing and delivers the saved failure once", async () => {
    let executed = 0;
    let allow = false;

    const state = await fixture(
      {},
      (request) => {
        if (request.settings.toolChoice === "none")
          return response(
            JSON.stringify({
              decision: allow ? "allow" : "needs_approval",
              reason: "Needs owner confirmation",
            }),
          );

        if (request.messages.at(-1)?.role === "tool") return response("Service restarted");

        return Stream.make({
          type: "completed",
          response: {
            output: [
              {
                type: "tool-call",
                namespace: "poppet_system",
                name: "bash",
                callId: "bash-1",
                arguments: JSON.stringify({
                  command: "restart-service",
                  cwd: "/tmp",
                  timeoutSeconds: 5,
                }),
              },
            ],
            continuation: { version: 1, provider: "test-provider", model: "test-model", data: {} },
            finishReason: "tool-calls",
            usage: null,
          },
        });
      },
      true,
      {},
      undefined,
      {
        run: () =>
          Effect.sync(() => {
            executed++;

            return { stdout: "done", stderr: "", exitCode: 0, truncated: false };
          }),
      },
    );

    try {
      const id = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const item = yield* scheduled(yield* gateway.resolveDestination("scheduled-thread"));
          expect(item.status).toBe("failed");
          expect(item.reason).toContain("Command needs approval");
          expect(item.reason).toContain("restart-service");
          expect(executed).toBe(0);
          yield* gateway.deliverNext;

          return item.id;
        }),
      );

      await state.run(Gateway.use((gateway) => gateway.deliverNext));
      expect(state.sent).toHaveLength(1);
      expect(state.sent[0]!.text).toContain("Scheduled task failed");
      expect(state.sent[0]!.text).toContain("restart-service");
      expect(state.sent[0]!.text).not.toContain("Reply /approve");
      await state.run(
        Effect.gen(function* () {
          const tasks = yield* TaskRepository;
          expect(tasks.occurrence(id).status).toBe("failed");
          expect(tasks.list()).toHaveLength(1);
          allow = true;
          tasks.retry(id, 0);
          const claimed = tasks.claim(0)!;
          yield* executeOccurrence(tasks, claimed.occurrence, claimed.task);
          expect(tasks.occurrence(id).status).toBe("completed");
          yield* (yield* Gateway).deliverNext;
          expect(tasks.deliveries(id)).toHaveLength(2);
          expect(new Set(tasks.deliveries(id).map((part) => part.runId)).size).toBe(2);
        }),
      );
      expect(executed).toBe(1);
      expect(state.sent).toHaveLength(2);
      expect(state.sent[1]!.text).toBe("Service restarted");
    } finally {
      await state.close();
    }
  });

  test("when skill selections change across restart, preserves valid snapshots and resets only with new", async () => {
    const state = await fixture();

    try {
      const root = join(state.directory, "skills", "review");
      await mkdir(join(state.directory, "skills", "review"), { recursive: true });
      await writeFile(join(state.directory, "skills", "review", "SKILL.md"), "Review procedure");
      let selected = "";
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("skill", "thread", "/new --skill review Review"));
          yield* gateway.processNext;
          const session = (yield* (yield* Store).sessions)[0]!;
          selected = session.id;
          expect(session.skill).toEqual(yield* (yield* Skills).load("review"));
        }),
      );
      await rm(root, { recursive: true });
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const store = yield* Store;
          yield* gateway.accept(message("continue", "thread", "Continue"));
          yield* gateway.processNext;
          expect(yield* store.sessions).toHaveLength(1);
          yield* gateway.accept(message("bad-skill", "thread", "/new --skill missing Review"));
          yield* gateway.processNext;
          expect((yield* GatewayRepository).binding("discord", "bot", "guild", "thread")).toBe(
            selected,
          );
          yield* gateway.accept(message("unscoped", "thread", "/new Review"));
          yield* gateway.processNext;
          expect(
            (yield* store.sessions).find((session) => session.id !== selected)?.skill,
          ).toBeNull();
        }),
      );
      expect(state.requests[0]?.instructions).toContain("Review procedure");
      expect(state.requests[1]?.instructions).toContain("Review procedure");
      expect(state.requests[2]?.instructions).not.toContain("Review procedure");
    } finally {
      await state.close();
    }
  });
  test.each([false, true])(
    "when conversation access is revoked=%s, validates current authorization before saving chat task delivery",
    async (revoked) => {
      let denied = false;
      let calls = 0;

      const state = await fixture(
        {
          checkAccess: () =>
            denied
              ? Effect.fail(new ChannelError({ reason: "permission", message: "Access revoked" }))
              : Effect.void,
        },
        () => {
          if (++calls > 1) return response("Task saved");
          denied = revoked;

          return Stream.make({
            type: "completed" as const,
            response: {
              output: [
                {
                  type: "tool-call" as const,
                  callId: "create",
                  name: "manage_tasks",
                  namespace: "poppet_tasks",
                  arguments: JSON.stringify({
                    action: "create",
                    id: null,
                    name: "Weekly review",
                    prompt: "Summarize recent conversations",
                    schedule: { type: "cron", expression: "0 9 * * 5", timezone: "Europe/London" },
                    delivery: "here",
                    skill: null,
                    after: null,
                    revision: null,
                    target: null,
                    until: null,
                  }),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: null,
              continuation: {
                version: 1 as const,
                provider: "test-provider",
                model: "test-model",
                data: {},
              },
            },
          });
        },
        true,
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.accept(
              message("schedule", null, "Create a weekly review and deliver it here"),
            );
            yield* gateway.processNext;
            const tasks = (yield* TaskRepository).list();

            if (revoked) {
              expect(tasks).toEqual([]);
              const store = yield* Store;
              const run = (yield* store.runs((yield* store.sessions)[0]!.id))[0]!;
              expect(run.status).toBe("completed");
              expect(yield* store.toolCalls(run.id)).toMatchObject([
                { status: "failed", failureReason: "agent:tool-permission" },
              ]);
            } else
              expect(tasks[0]).toMatchObject({
                name: "Weekly review",
                provider: "test-provider",
                model: "test-model",
                destination: {
                  adapter: "discord",
                  account: "bot",
                  ownerId: "owner",
                  scopeId: "guild",
                  parentId: "parent",
                  conversationId: "thread-schedule",
                },
              });
          }),
        );
        expect(calls).toBe(revoked ? 1 : 2);
        expect(state.requests).toHaveLength(2);
      } finally {
        await state.close();
      }
    },
  );

  test("when a selected skill changes after restart, retains its snapshot until a new unskilled session replaces it", async () => {
    const adapter = "test-channel";
    const state = await fixture({ id: adapter });
    const path = join(state.directory, "skills/review/SKILL.md");
    await mkdir(join(state.directory, "skills/review"), { recursive: true });
    await writeFile(path, "Summarize progress using the saved review procedure.");

    try {
      const ids = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const repo = yield* GatewayRepository;
          const store = yield* Store;
          yield* gateway.accept(message("ordinary", "chat", "Original conversation"));
          yield* gateway.processNext;
          const original = repo.binding(adapter, "bot", "guild", "chat")!;
          const selected = message("selected", "chat", "/new --skill review Review Acorn");
          yield* gateway.accept(selected);
          yield* gateway.accept(selected);
          yield* gateway.processNext;
          expect(yield* gateway.processNext).toBe(false);
          const skilled = repo.binding(adapter, "bot", "guild", "chat")!;
          expect(skilled).not.toBe(original);
          expect(yield* store.session(skilled)).toMatchObject({
            skill: {
              name: "review",
              content: "Summarize progress using the saved review procedure.",
            },
          });
          expect((yield* store.messages(skilled)).map((entry) => entry.message)).toContainEqual({
            role: "user",
            text: "Review Acorn",
          });
          expect(yield* store.session(original)).toMatchObject({ skill: null });
          yield* gateway.accept(message("status", "chat", "/status"));

          while (yield* gateway.deliverNext) {
            /* Drain the saved replies and status. */
          }

          return { original, skilled };
        }),
      );

      expect(state.sent.at(-1)?.text).toContain("Skill: review");
      await writeFile(path, "Edited procedure that existing sessions must not see.");
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.accept(message("follow-up", "chat", "Continue the review"));
          yield* gateway.processNext;
          expect((yield* GatewayRepository).binding(adapter, "bot", "guild", "chat")).toBe(
            ids.skilled,
          );
          expect(state.requests.at(-1)?.instructions).toContain("saved review procedure");
          expect(state.requests.at(-1)?.instructions).not.toContain("Edited procedure");
        }),
      );
      await rm(path);
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const store = yield* Store;
          yield* gateway.accept(message("deleted-skill", "chat", "Continue again"));
          yield* gateway.processNext;
          expect(state.requests.at(-1)?.instructions).toContain("saved review procedure");
          yield* gateway.accept(message("reset", "chat", "/new Start without a skill"));
          yield* gateway.processNext;
          const current = (yield* GatewayRepository).binding(adapter, "bot", "guild", "chat")!;
          expect(current).not.toBe(ids.skilled);
          expect(yield* store.session(current)).toMatchObject({ skill: null });
          expect(state.requests.at(-1)?.instructions).not.toContain("saved review procedure");
          expect(yield* store.sessions).toHaveLength(3);
          expect(yield* store.messages(ids.original)).toHaveLength(2);
          expect(yield* store.messages(ids.skilled)).toHaveLength(6);
        }),
      );
      expect(state.requests).toHaveLength(5);
    } finally {
      await state.close();
    }
  });

  test("when selection is invalid, replies without changing the binding or invoking a model", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const repo = yield* GatewayRepository;
          const store = yield* Store;
          yield* gateway.accept(message("original", "chat"));
          yield* gateway.processNext;
          const original = repo.binding("discord", "bot", "guild", "chat");

          for (const [index, text] of [
            "/new",
            "/new --skill",
            "/new --skill review",
            "/new --skill ../review prompt",
            "/new --skill missing prompt",
          ].entries()) {
            yield* gateway.accept(message(`bad-${index}`, "chat", text));
            yield* gateway.processNext;
            expect(repo.binding("discord", "bot", "guild", "chat")).toBe(original);
          }

          yield* gateway.accept(message("unbound", null, "/new --skill missing prompt"));
          yield* gateway.processNext;
          expect(repo.binding("discord", "bot", "guild", "thread-unbound")).toBeNull();
          expect(yield* store.sessions).toHaveLength(1);
          expect(state.requests).toHaveLength(1);

          while (yield* gateway.deliverNext) {
            /* Drain validation replies. */
          }
        }),
      );
      expect(state.sent).toHaveLength(7);
      expect(state.sent.filter((entry) => entry.text.startsWith("Use /new"))).toHaveLength(4);
      expect(state.sent.at(-1)?.destination).toBe("thread-unbound");
      expect(state.sent.at(-1)?.text).toContain("Could not load the selected skill");
    } finally {
      await state.close();
    }
  });

  test("when a selected session exists before binding, recovers it without reloading its skill", async () => {
    const state = await fixture();
    const path = join(state.directory, "skills/review/SKILL.md");
    await mkdir(join(state.directory, "skills/review"), { recursive: true });
    await writeFile(path, "Original saved procedure.");

    try {
      const selectedId = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const { database } = yield* StoreDatabase;
          yield* gateway.accept(message("original", "chat"));
          yield* gateway.processNext;
          const repo = yield* GatewayRepository;
          const original = repo.binding("discord", "bot", "guild", "chat");
          yield* gateway.accept(message("selected", "chat", "/new --skill review First request"));
          database.run(
            "CREATE TRIGGER fail_binding BEFORE INSERT ON gateway_bindings BEGIN SELECT RAISE(ABORT, 'test'); END",
          );
          expect(yield* gateway.processNext.pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "storage",
          );
          const sessions = yield* (yield* Store).sessions;
          expect(sessions).toHaveLength(2);
          expect(repo.binding("discord", "bot", "guild", "chat")).toBe(original);
          // An abrupt process crash here leaves the input queued instead of running failure cleanup.
          database.run("UPDATE gateway_inbox SET state = 'queued' WHERE external_id = 'selected'");

          return sessions.find((session) => session.skill?.name === "review")!.id;
        }),
      );

      await rm(path);
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          (yield* StoreDatabase).database.run("DROP TRIGGER fail_binding");
          yield* gateway.recover;
          yield* gateway.processNext;
          expect((yield* GatewayRepository).binding("discord", "bot", "guild", "chat")).toBe(
            selectedId,
          );
          expect(yield* (yield* Store).sessions).toHaveLength(2);
          expect(state.requests).toHaveLength(2);
          expect(state.requests[1]?.instructions).toContain("Original saved procedure.");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when polling overloads the inbox, commits rejections and replies atomically before checkpointing", async () => {
    const offsets: (string | null)[] = [];

    const state = await fixture({
      id: "telegram",
      poll: (cursor) =>
        Effect.sync(() => {
          offsets.push(cursor);

          return Array.from({ length: 65 }, (_, index) => ({
            cursor: String(index + 1),
            message: message(String(index), "private-chat"),
          })).slice(Number(cursor ?? 0));
        }),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const { database } = yield* StoreDatabase;
          database.run(
            "CREATE TRIGGER reject_reply BEFORE INSERT ON gateway_deliveries BEGIN SELECT RAISE(ABORT, 'test'); END",
          );
          expect(yield* gateway.pollOnce.pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "storage",
          );
          const repo = yield* GatewayRepository;
          expect(repo.cursor("telegram", "bot")).toBe("64");
          expect(repo.cursor("discord", "bot")).toBeNull();
          expect(repo.cursor("telegram", "another-bot")).toBeNull();
          expect(
            database.query("SELECT id FROM gateway_inbox WHERE external_id = '64'").get(),
          ).toBeNull();
          expect((yield* GatewayRepository).status()).toMatchObject({
            queued: 64,
            failedRequests: 0,
          });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          (yield* StoreDatabase).database.run("DROP TRIGGER reject_reply");
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.pollOnce;
          yield* gateway.pollOnce;
          expect((yield* GatewayRepository).cursor("telegram", "bot")).toBe("65");
          expect((yield* GatewayRepository).status()).toMatchObject({
            queued: 64,
            failedRequests: 1,
            pendingDelivery: 1,
          });
          expect(yield* gateway.deliverNext).toBe(true);
          expect(yield* gateway.deliverNext).toBe(false);
        }),
      );
      expect(offsets).toEqual([null, "64", "65"]);
      expect(state.requests).toEqual([]);
      expect(state.sent).toMatchObject([
        { destination: "private-chat", text: expect.stringContaining("not queued") },
      ]);
    } finally {
      await state.close();
    }
  });

  test("when cursor commit fails, replays acceptance without repeating model work", async () => {
    const state = await fixture({
      id: "telegram",
      poll: () => Effect.succeed([{ cursor: "2", message: message("first", "private-chat") }]),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const { database } = yield* StoreDatabase;
          database.run(
            "CREATE TRIGGER reject_cursor BEFORE INSERT ON gateway_cursors BEGIN SELECT RAISE(ABORT, 'test'); END",
          );
          const gateway = yield* Gateway;
          expect(yield* gateway.pollOnce.pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "storage",
          );
          expect((yield* GatewayRepository).cursor("telegram", "bot")).toBeNull();
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 1 });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          (yield* StoreDatabase).database.run("DROP TRIGGER reject_cursor");
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.pollOnce;
          yield* gateway.processNext;
          expect((yield* GatewayRepository).cursor("telegram", "bot")).toBe("2");
          expect(yield* gateway.processNext).toBe(false);
        }),
      );
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test("when polling updates replay after restart, deduplicates accepted work and retains conversation bindings", async () => {
    const state = await fixture({
      id: "telegram",
      poll: (cursor) =>
        Effect.succeed(
          cursor === null
            ? [
                { cursor: "2", message: message("first", "private-chat") },
                { cursor: "3", message: null },
              ]
            : [{ cursor: "4", message: message("second", "private-chat", "Continue") }],
        ),
    });

    try {
      const session = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          // Simulate death after inbox commit but before advancing the polling cursor.
          yield* gateway.accept(message("first", "private-chat"));
          yield* gateway.pollOnce;
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          const repo = yield* GatewayRepository;
          expect(repo.cursor("telegram", "bot")).toBe("3");

          return repo.binding("telegram", "bot", "guild", "private-chat");
        }),
      );

      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.pollOnce;
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          const repo = yield* GatewayRepository;
          expect(repo.binding("telegram", "bot", "guild", "private-chat")).toBe(session);
          expect(repo.binding("telegram", "other-bot", "guild", "private-chat")).toBeNull();
          expect(repo.binding("discord", "bot", "guild", "private-chat")).toBeNull();
          const store = yield* Store;
          expect(yield* store.sessions).toHaveLength(1);
          expect(yield* store.runs(session!)).toHaveLength(2);
        }),
      );
      expect(state.requests).toHaveLength(2);
      expect(state.sent.map((item) => item.destination)).toEqual(["private-chat", "private-chat"]);
    } finally {
      await state.close();
    }
  });

  test("when cancellation is polled with a full inbox, handles it without starting another run", async () => {
    const started = Deferred.makeUnsafe<void>();
    let cancel = false;

    const state = await fixture(
      {
        id: "telegram",
        poll: () =>
          Effect.succeed(
            cancel
              ? [
                  { cursor: "3", message: message("overflow", "private-chat", "Next") },
                  { cursor: "4", message: message("cancel", "private-chat", "/cancel") },
                ]
              : [{ cursor: "2", message: message("hold", "private-chat", "Hold") }],
          ),
      },
      () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.pollOnce;
          const processing = yield* gateway.processNext.pipe(Effect.forkChild);
          yield* Deferred.await(started);

          for (let index = 0; index < 63; index++)
            yield* gateway.accept(message(`queued-${index}`, "private-chat"));
          cancel = true;
          yield* gateway.pollOnce;
          yield* Fiber.join(processing);
          expect((yield* GatewayRepository).cursor("telegram", "bot")).toBe("4");
          expect((yield* GatewayRepository).status()).toMatchObject({
            queued: 0,
            executing: 0,
            failedRequests: 1,
            pendingDelivery: 2,
          });
          yield* gateway.pollOnce;
          expect(yield* gateway.processNext).toBe(false);
          expect((yield* GatewayRepository).status()).toMatchObject({ pendingDelivery: 2 });
          const store = yield* Store;
          const session = (yield* store.sessions)[0]!;
          expect((yield* store.runs(session.id)).map((run) => run.status)).toEqual(["interrupted"]);
        }),
      );
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test("when a saved occurrence is delivered after restart, uses its destination snapshot without changing chat", async () => {
    const adapter = "test-channel";
    const state = await fixture({ id: adapter });

    try {
      const occurrence = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const destination = yield* gateway.resolveDestination("scheduled-thread");
          const item = yield* scheduled(destination);
          const { database } = yield* StoreDatabase;
          // Later configuration and task edits cannot redirect this occurrence.
          database.run("UPDATE jobs SET destination = ?", [
            JSON.stringify({ ...destination, conversationId: "different-thread" }),
          ]);

          return item;
        }),
      );

      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          expect(yield* gateway.deliverNext).toBe(true);
          expect(yield* gateway.deliverNext).toBe(false);
          expect((yield* TaskRepository).deliveries(occurrence.id)).toMatchObject([
            { state: "sent", attempts: 0 },
          ]);
          expect((yield* TaskRepository).occurrence(occurrence.id).status).toBe("completed");
          expect(
            (yield* GatewayRepository).binding(adapter, "bot", "guild", "scheduled-thread"),
          ).toBeNull();
        }),
      );
      expect(state.sent).toEqual([
        { destination: "scheduled-thread", text: "Answer", nonce: expect.any(String) },
      ]);
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test.each(["unavailable", "permission", "uncertain"] as const)(
    "when scheduled delivery is %s, keeps its state separate from execution across restart",
    async (reason) => {
      let attempts = 0;
      const destinations: string[] = [];

      const state = await fixture({
        send: (destination) => {
          destinations.push(destination);

          return ++attempts === 1
            ? Effect.fail(new ChannelError({ reason, message: "Send failed", retryAfterMs: 1000 }))
            : Effect.succeed("sent");
        },
      });

      try {
        const occurrence = await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            const item = yield* scheduled(yield* gateway.resolveDestination("saved-thread"));
            yield* gateway.deliverNext;
            expect((yield* TaskRepository).occurrence(item.id).status).toBe("completed");

            return item;
          }),
        );

        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.recover;
            yield* TestClock.adjust("1 second");
            expect(yield* gateway.deliverNext).toBe(reason === "unavailable");
            expect((yield* TaskRepository).deliveries(occurrence.id)[0]?.state).toBe(
              ({ unavailable: "sent", permission: "failed", uncertain: "uncertain" } as const)[
                reason
              ],
            );
            expect(yield* gateway.processNext).toBe(false);
            const repo = yield* TaskRepository;
            expect(() => repo.retry(occurrence.id, 0)).toThrow("Only unsuccessful occurrences");
          }),
        );
        expect(state.requests).toHaveLength(1);
        expect(destinations).toEqual(
          reason === "unavailable" ? ["saved-thread", "saved-thread"] : ["saved-thread"],
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when a scheduled send crashes, retains uncertainty and blocks later chunks after restart", async () => {
    const sending = Deferred.makeUnsafe<void>();
    let attempts = 0;

    const state = await fixture({
      textLimit: 4,
      send: () => {
        attempts++;

        return Deferred.succeed(sending, undefined).pipe(Effect.andThen(Effect.never));
      },
    });

    try {
      const occurrence = await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const item = yield* scheduled(yield* gateway.resolveDestination("saved-thread"));
          const fiber = yield* gateway.deliverNext.pipe(Effect.forkChild);
          yield* Deferred.await(sending);
          yield* Fiber.interrupt(fiber);
          expect((yield* TaskRepository).deliveries(item.id).map((part) => part.state)).toEqual([
            "sending",
            "pending",
          ]);

          return item;
        }),
      );

      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          expect(yield* gateway.deliverNext).toBe(false);
          expect(
            (yield* TaskRepository).deliveries(occurrence.id).map((part) => part.state),
          ).toEqual(["uncertain", "pending"]);
          expect((yield* TaskRepository).occurrence(occurrence.id).status).toBe("completed");
        }),
      );
      expect(attempts).toBe(1);
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test.each(["owner", "guild", "parent", "account"])(
    "when scheduled delivery has changed %s authorization, rejects it",
    async (field) => {
      const state = await fixture();

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            const original = yield* gateway.resolveDestination("saved-thread");

            const destination = {
              ...original,
              ownerId: field === "owner" ? "other" : original.ownerId,
              scopeId: field === "guild" ? "other" : original.scopeId,
              parentId: field === "parent" ? "other" : original.parentId,
              account: field === "account" ? "other" : original.account,
            };

            const item = yield* scheduled(destination);
            expect(yield* gateway.deliverNext).toBe(false);
            expect((yield* TaskRepository).deliveries(item.id)).toMatchObject([
              { state: "failed" },
            ]);
          }),
        );
        expect(state.sent).toEqual([]);
        expect(state.requests).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

  test("when threads are deleted or revoked, rechecks access before delivery and keeps destination-free tasks local", async () => {
    let allowed = true;

    const state = await fixture({
      checkAccess: () =>
        allowed
          ? Effect.void
          : Effect.fail(new ChannelError({ reason: "permission", message: "Thread deleted" })),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const destination = yield* gateway.resolveDestination("saved-thread");
          const delivered = yield* scheduled(destination);
          const local = yield* scheduled(null);
          allowed = false;
          yield* gateway.deliverNext;
          expect((yield* TaskRepository).deliveries(delivered.id)).toMatchObject([
            { state: "failed" },
          ]);
          expect((yield* TaskRepository).deliveries(local.id)).toEqual([]);
          expect(yield* gateway.deliverNext).toBe(false);
        }),
      );
      expect(state.sent).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test("when explicit task destinations are supplied, validates them before saving and rejects unauthorized parents", async () => {
    let parent = "parent";
    const state = await fixture({ destination: () => Effect.succeed(parent) });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const repo = yield* TaskRepository;
          const store = yield* Store;

          const command = {
            action: "add" as const,
            task: {
              name: "Summary",
              prompt: "Summarize",
              provider: "test-provider",
              model: "test-model",
              workload: "assistant" as const,
              schedule: { type: "once" as const, at: 0 },
            },
            delivery: { adapter: "discord", conversationId: "saved-thread" },
          };

          expect(
            yield* executeTaskCommand(repo, store, command, 0).pipe(Effect.result),
          ).toHaveProperty("failure.message", expect.stringContaining("Start worker"));
          expect(repo.list()).toEqual([]);
          const resolved = yield* gateway.resolveDestination("saved-thread");

          const added = yield* executeTaskCommand(repo, store, command, 0).pipe(
            Effect.provideService(TaskDestinations, { resolve: () => Effect.succeed(resolved) }),
          );

          expect(added).toHaveProperty("destination", resolved);
          parent = "unauthorized";
          expect(
            yield* gateway.resolveDestination("saved-thread").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          expect(repo.list()).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when reactions fail, continues model work and reply delivery without repetition", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({
            failedRequests: 0,
            pendingDelivery: 0,
          });
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(state.sent.map((entry) => entry.text)).toEqual(["Answer"]);
    } finally {
      await state.close();
    }
  });

  test("when inference fails, reports it in the thread without partial text or retry", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({
            failedRequests: 1,
            executing: 0,
          });
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

  test("when a message is accepted, answers and delivers it without waiting for a polling timer", async () => {
    const incoming = Effect.runSync(Queue.make<IncomingMessage>());
    const delivered = Deferred.makeUnsafe<void>();

    const state = await fixture({
      messages: Stream.fromQueue(incoming),
      send: () => Deferred.succeed(delivered, undefined).pipe(Effect.as("sent")),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          // Let every loop reach its idle wait; the test clock never advances after this.
          yield* TestClock.adjust("0 millis");
          yield* Queue.offer(incoming, message("prompt"));
          yield* Deferred.await(delivered);
          expect(state.requests).toHaveLength(1);
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when receive and delivery loops shut down, preserves queued work and interrupts active inference", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 1, executing: 1 });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.processNext;
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0, executing: 0 });
          const session = (yield* Store).sessions;
          const saved = (yield* session)[0];

          if (saved === undefined) throw new Error("Missing session");
          expect(
            (yield* (yield* Store).runs(saved.id)).filter((run) => run.status === "interrupted"),
          ).toHaveLength(1);
        }),
      );
      expect(state.requests).toHaveLength(4);
    } finally {
      await state.close();
    }
  });

  test("when parent and thread messages arrive across restart, applies mention rules and deduplicates while resuming bindings", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0 });
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

  test("when queued work and committed answers survive a crash, recovers them without replaying interrupted runs", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0, executing: 0 });
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

  test("when thread creation is uncertain, reconciles it before inference", async () => {
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
    "when delivery is %s, handles it without repeating inference",
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
            expect((yield* GatewayRepository).status()).toMatchObject({
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

  test("when replies exceed the chunk limit, splits at paragraph, line, then word boundaries without losing text", () => {
    const paragraphs = `${"a".repeat(12)}\n\n${"b".repeat(5)} ${"c".repeat(4)}`;

    expect(chunks(paragraphs, 20)).toEqual([
      `${"a".repeat(12)}\n\n`,
      `${"b".repeat(5)} ${"c".repeat(4)}`,
    ]);
    expect(chunks("one two\nthree four", 12)).toEqual(["one two\n", "three four"]);
    expect(chunks("alpha beta gamma", 12)).toEqual(["alpha beta ", "gamma"]);
    // A break in the first half would leave a tiny chunk, so the hard limit is used instead.
    expect(chunks(`a ${"b".repeat(20)}`, 10)).toEqual(["a bbbbbbbb", "bbbbbbbbbb", "bb"]);
    expect(chunks(`${"x".repeat(9)}😀y`, 10)).toEqual(["x".repeat(9), "😀y"]);
    expect(chunks("", 10)).toEqual([]);
  });

  test("when a Unicode chunk send is uncertain, preserves text and stops later chunks", async () => {
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

  test("when a thread is cancelled, stops only its active and queued requests while CLI chat continues", async () => {
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
          yield* gateway.accept(message("queued", "thread-first", "/new --skill missing Queued"));
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
          expect(yield* store.sessions).toHaveLength(2);
          yield* Stream.runDrain((yield* Agent).send(firstSession, "CLI follow-up"));
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0, executing: 0 });
        }),
      );
      expect(state.requests).toHaveLength(4);
    } finally {
      await state.close();
    }
  });

  test("when pending work reaches capacity, rejects excess work and keeps cancellation available", async () => {
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
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0 });
          expect(yield* gateway.processNext).toBe(false);
        }),
      );
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });
});

describe("conversationNaming", () => {
  test("when a session binding is replaced, skips naming the old session", async () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const renames: string[] = [];
    let first = true;
    let current = "Original";

    const state = await fixture({
      naming: {
        sanitize: (title) => title,
        changes: Stream.never,
        conversation: (_input, title) => {
          expect(title).toBe("Original");

          return Effect.succeed({ id: "managed", managedName: title });
        },
        current: () =>
          Effect.gen(function* () {
            if (first) {
              first = false;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }

            return current;
          }),
        rename: (_input, _id, _expected, title) =>
          Effect.sync(() => {
            renames.push(title);
            current = title;

            return title;
          }),
      },
    });

    await mkdir(join(state.directory, "skills/review"), { recursive: true });
    await writeFile(join(state.directory, "skills/review/SKILL.md"), "A review procedure.");

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const repo = yield* GatewayRepository;
          const store = yield* Store;
          yield* gateway.accept(message("original", null, "/new --skill review Original"));
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          const old = repo.binding("discord", "bot", "guild", "managed")!;
          yield* store.renameSession(old, "Old delayed title");
          const naming = yield* gateway.nameNext.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* gateway.accept(message("replacement", "managed", "/new New prompt"));
          yield* gateway.processNext;
          const replacement = repo.binding("discord", "bot", "guild", "managed")!;
          yield* store.renameSession(replacement, "New title");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(naming);
          expect(renames).toEqual([]);
          expect(repo.namedBinding("discord", "bot", "managed")).toMatchObject({
            sessionId: replacement,
            syncedTitle: null,
            namingDisabled: false,
          });
          yield* gateway.deliverNext;
          yield* gateway.nameNext;
          expect(renames).toEqual(["New title"]);
          expect(repo.namedBinding("discord", "bot", "managed")).toMatchObject({
            managedName: "New title",
            creationMessageId: "original",
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([
    "generated",
    "manual",
    "external-edit",
    "permission",
    "rate-limit",
    "uncertain",
    "existing-thread",
    "unproven-creation",
  ])(
    "when names are %s after answer delivery, handles them without repeating inference",
    async (mode) => {
      let current = "First question";
      const renames: string[] = [];
      let titleRequests = 0;

      const naming: NonNullable<MessagingChannel["Service"]["naming"]> = {
        sanitize: (title) => title,
        changes: Stream.never,
        conversation: (input, title) =>
          Effect.succeed({
            id: `thread-${input.messageId}`,
            managedName: mode === "unproven-creation" ? null : title,
          }),
        current: () => Effect.succeed(current),
        rename: (_input, _id, expected, title) =>
          Effect.suspend(() => {
            if (current !== expected) return Effect.succeed(null);
            renames.push(title);

            if (mode === "permission" || mode === "rate-limit")
              return Effect.fail(
                new ChannelError({
                  reason: mode === "permission" ? "permission" : "unavailable",
                  message: "Cannot rename",
                  retryAfterMs: 60000,
                }),
              );
            current = title;

            return mode === "uncertain"
              ? Effect.fail(new ChannelError({ reason: "uncertain", message: "Lost reply" }))
              : Effect.succeed(current);
          }),
      };

      const state = await fixture({ naming }, (request) => {
        if (request.settings.toolChoice === "none") {
          titleRequests++;
          expect(state.sent).toHaveLength(1);

          return response("Generated conversation title");
        }

        return response();
      });

      try {
        const savedId = await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            const store = yield* Store;
            const repo = yield* GatewayRepository;
            yield* gateway.accept(
              message("title", mode === "existing-thread" ? "existing" : null, "First question"),
            );
            yield* gateway.processNext;
            yield* gateway.nameNext;
            expect(titleRequests).toBe(0);
            const session = (yield* store.sessions)[0];

            if (!session) throw new Error("Missing session");
            expect(session.title).toBe("First question");
            yield* gateway.deliverNext;

            if (mode === "manual") yield* store.renameSession(session.id, "My manual title");

            if (mode === "external-edit") current = "User's thread name";
            yield* gateway.nameNext;
            yield* gateway.nameNext;
            expect((yield* store.runs(session.id))[0]?.status).toBe("completed");
            expect(yield* store.messages(session.id)).toHaveLength(2);
            expect((yield* store.session(session.id))?.title).toBe(
              mode === "manual" ? "My manual title" : "Generated conversation title",
            );

            if (["external-edit", "permission", "rate-limit"].includes(mode)) {
              expect(repo.namedBinding("discord", "bot", "thread-title")?.namingDisabled).toBe(
                true,
              );
            }

            return session.id;
          }),
        );

        // Reopen the store and gateway. Neither naming nor uncertain renames repeat.
        await state.run(
          Effect.gen(function* () {
            yield* (yield* Gateway).nameNext;
            expect((yield* (yield* Store).session(savedId))?.titleAttempted).toBe(
              mode !== "manual",
            );
          }),
        );
        expect(titleRequests).toBe(mode === "manual" ? 0 : 1);
        expect(renames).toEqual(
          ["external-edit", "existing-thread", "unproven-creation"].includes(mode)
            ? []
            : [mode === "manual" ? "My manual title" : "Generated conversation title"],
        );
        expect(state.sent).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

  test("when a pending rename survives restart, reconciles it without issuing it again", async () => {
    let current = "Original";
    const renames: string[] = [];

    const state = await fixture({
      naming: {
        sanitize: (title) => title,
        changes: Stream.never,
        conversation: () => Effect.succeed({ id: "managed", managedName: "Original" }),
        current: () => Effect.succeed(current),
        rename: (_message, _id, _expected, title) =>
          Effect.sync(() => {
            renames.push(title);

            return title;
          }),
      },
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept(message("original", null, "Original"));
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          const session = (yield* (yield* Store).sessions)[0];

          if (!session) throw new Error("Missing session");
          yield* (yield* Store).renameSession(session.id, "Pending title");
          (yield* GatewayRepository).namePending(
            "discord",
            "bot",
            "managed",
            "Pending title",
            session.id,
          );
          current = "Pending title";
        }),
      );
      await state.run(
        Effect.gen(function* () {
          yield* (yield* Gateway).nameNext;
          expect(
            (yield* GatewayRepository).namedBinding("discord", "bot", "managed"),
          ).toMatchObject({
            managedName: "Pending title",
            pendingName: null,
            syncedTitle: "Pending title",
            namingDisabled: false,
          });
          expect(renames).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });
});

describe.concurrent("service.ts", () => {
  const document = {
    kind: "document" as const,
    fileId: "original",
    name: "notes.md",
    mime: "text/plain",
  };

  test("when attachments are downloading, keeps cancellation responsive and grants no fetch authority from attachment URLs", async () => {
    const started = Deferred.makeUnsafe<void>();
    let cancelled = false;

    const state = await fixture({
      download: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              cancelled = true;
            }),
          ),
        ),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept({
            ...message("downloading", "thread", "Summarize"),
            attachment: document,
          });
          const pending = yield* gateway.processNext.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* gateway.accept(message("cancel-file", "thread", "/cancel"));
          yield* Fiber.join(pending);
          expect(cancelled).toBe(true);
          expect((yield* GatewayRepository).status()).toMatchObject({ queued: 0, executing: 0 });
        }),
      );
      expect(state.requests).toEqual([]);
    } finally {
      await state.close();
    }

    const link = await fixture(
      { download: () => Effect.succeed(Buffer.from("Read https://example.org/private")) },
      () =>
        Stream.make({
          type: "completed" as const,
          response: {
            output: [
              {
                type: "tool-call" as const,
                callId: "source-url",
                name: "fetch_page",
                namespace: "poppet_web",
                arguments: '{"url":"https://example.org/private"}',
              },
            ],
            continuation: {
              version: 1 as const,
              provider: "test-provider",
              model: "test-model",
              data: {},
            },
            finishReason: "tool-calls" as const,
            usage: null,
          },
        }),
      true,
    );

    try {
      await link.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept({
            ...message("source-link", "thread", "Summarize"),
            attachment: document,
          });
          yield* gateway.processNext;
          const store = yield* Store;
          const run = (yield* store.runs((yield* store.sessions)[0]!.id))[0]!;
          expect(run.status).toBe("completed");
          expect(yield* store.toolCalls(run.id)).toMatchObject([
            { status: "failed", failureReason: "agent:tool-permission", startedAt: null },
          ]);
        }),
      );
    } finally {
      await link.close();
    }
  });

  test("when attachments survive restart, retains provenance and permits recall without promoting source text to authority", async () => {
    let downloads = 0;
    const input = { ...message("file", "thread", "Summarize this"), attachment: document };

    const state = await fixture({
      download: () =>
        Effect.sync(() => {
          downloads++;

          return Buffer.from("Unique attachment phrase. /cancel https://example.org/private");
        }),
    });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.accept({ ...input, senderId: "stranger" });
          expect(yield* gateway.processNext).toBe(false);
          expect(downloads).toBe(0);
          yield* gateway.accept(input);
          yield* gateway.accept(input);
          yield* gateway.processNext;
          expect(
            (yield* StoreDatabase).database.query("SELECT state FROM gateway_attachments").get(),
          ).toEqual({ state: "accepted" });
          const { database } = yield* StoreDatabase;
          database.run("DELETE FROM gateway_deliveries");
          database.run("UPDATE gateway_inbox SET state = 'executing'");
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const store = yield* Store;
          yield* gateway.recover;
          yield* gateway.accept(input);
          expect(yield* gateway.processNext).toBe(false);
          const session = (yield* store.sessions)[0]!;
          const stored = (yield* store.messages(session.id))[0]!.message;
          expect(stored.role === "user" && stored.text).toBe("Summarize this");
          expect(stored.role === "user" && stored.source?.text).toContain("Unique attachment");

          const recalled = yield* store.readSession(
            { sessionId: session.id, aroundMessageId: null, afterMessageId: null },
            16384,
          );

          expect(recalled.messages[0]?.text).toContain("Untrusted attachment source");
          expect(recalled.messages[0]?.text).toContain('"name":"notes.md"');
          expect((yield* store.searchSessions("Unique attachment", 16384)).matches).toHaveLength(1);
          yield* gateway.deliverNext;
          expect(yield* gateway.deliverNext).toBe(false);
        }),
      );
      expect(downloads).toBe(1);
      expect(state.requests).toHaveLength(1);
      expect(state.requests[0]?.messages[0]).not.toHaveProperty("source");
      expect(
        state.requests[0]?.messages[0]?.role === "user" && state.requests[0].messages[0].text,
      ).toContain("Untrusted attachment source");
      expect(state.sent).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test("when extraction was saved before inference, reuses it and rejects context overflow", async () => {
    let downloads = 0;

    const state = await fixture(
      {
        download: () =>
          Effect.sync(() => {
            downloads++;

            return Buffer.from(`x${"\n".repeat(32767)}`);
          }),
      },
      undefined,
      false,
      { contextBytes: 65536 },
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const repo = yield* GatewayRepository;
          yield* gateway.accept({ ...message("saved", "saved-thread", ""), attachment: document });
          const entry = repo.next("discord", "bot", Number.MAX_SAFE_INTEGER)!;
          repo.processing(entry.id);
          repo.extracted(entry.id, {
            kind: "document",
            name: "notes.md",
            mime: "text/plain",
            sha256: "a".repeat(64),
            version: 1,
            text: "Saved before inference",
            completeness: "Complete UTF-8 text.",
          });
          repo.state(entry.id, "executing");
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          expect(downloads).toBe(0);
          yield* gateway.accept({ ...message("overflow", "thread", ""), attachment: document });
          yield* gateway.processNext;
          yield* gateway.deliverNext;
          expect(state.sent.at(-1)?.text).toContain("context budget");
        }),
      );
      expect(state.requests).toHaveLength(1);
      expect(downloads).toBe(1);
    } finally {
      await state.close();
    }
  });

  test.each([
    { kind: "document" as const, name: "old.pdf", mime: "application/pdf" },
    { kind: "voice" as const, name: "Voice message", mime: "audio/ogg" },
  ])(
    "when previously extracted $kind text survives an update, finishes without downloading and retains history",
    async (metadata) => {
      const source = {
        ...metadata,
        sha256: "b".repeat(64),
        version: 1 as const,
        text: "Previously saved attachment text",
        completeness: "Saved extraction",
      };

      const state = await fixture(
        { download: () => Effect.die("Unexpected download") },
        undefined,
        true,
      );

      try {
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            const repo = yield* GatewayRepository;
            yield* gateway.accept({
              ...message("saved", "thread", ""),
              attachment: { ...document, ...metadata },
            });
            const entry = repo.next("discord", "bot", Number.MAX_SAFE_INTEGER)!;
            repo.processing(entry.id);
            repo.extracted(entry.id, source);
            repo.state(entry.id, "executing");
          }),
        );
        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.recover;
            yield* gateway.processNext;
            yield* gateway.deliverNext;
            const store = yield* Store;
            const session = (yield* store.sessions)[0]!;
            expect((yield* store.messages(session.id))[0]?.message).toMatchObject({ source });

            const recalled = yield* store.readSession(
              { sessionId: session.id, aroundMessageId: null, afterMessageId: null },
              16384,
            );

            expect(recalled.messages[0]?.text).toContain(source.text);
            expect(recalled.messages[0]?.text).toContain("Untrusted attachment source");
          }),
        );
        expect(state.requests).toHaveLength(1);
        expect(state.requests[0]?.tools.map((tool) => tool.name)).not.toContain("manage_tasks");
        expect(state.requests[0]?.tools.map((tool) => tool.name)).not.toContain("memory");
        expect(state.sent[0]?.text).toContain(
          metadata.kind === "voice" ? source.text : source.name,
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when PDFs or recordings arrive, rejects them before downloading or calling the model", async () => {
    const state = await fixture({ download: () => Effect.die("Unexpected download") });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;

          for (const attachment of [
            { ...document, name: "notes.pdf", mime: "application/pdf" },
            { ...document, kind: "unsupported" as const },
            { ...document, kind: "voice" as const, name: "Voice message", mime: "audio/ogg" },
          ]) {
            yield* gateway.accept({
              ...message(attachment.name, "thread", "Summarize"),
              attachment,
            });
            yield* gateway.processNext;
            yield* gateway.deliverNext;
            expect(state.sent.at(-1)?.text).toContain("not supported");
          }

          expect((yield* GatewayRepository).status()).toMatchObject({ failedRequests: 3 });
        }),
      );
      expect(state.sent).toHaveLength(3);
      expect(state.requests).toEqual([]);
    } finally {
      await state.close();
    }
  });
});
