import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Agent, Bash, type ChatPolicy, Pages, Skills, SkillsLive } from "@poppet/agent";
import { agentHarness, gatedStream, optionalService, testModel } from "@poppet/agent/test";
import { ProviderError, type ModelOperations, type ModelRequest } from "@poppet/provider";
import { DeliveryDestination, Store } from "@poppet/store";
import {
  ChatTasksLive,
  TaskRepository,
  TaskDeliveries,
  TaskRepositoryLive,
  TaskDestinations,
  executeTaskCommand,
  executeOccurrence,
} from "@poppet/tasks";
import { Console, Deferred, Effect, Fiber, Layer, Match, Queue, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import {
  ChannelError,
  MessagingChannel,
  type ApprovalAction,
  type ApprovalState,
  type IncomingMessage,
} from "#src/channel";
import { chunks } from "#src/replies";
import { GatewayRepository, GatewayRepositoryLive, TaskDeliveriesLive } from "#src/repository";
import { Gateway, GatewayLive } from "#src/service";

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
  mentioned: true,
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
  const harness = await agentHarness(policy);
  const { directory } = harness;
  const requests: ModelRequest[] = [];
  const sent: { destination: string; text: string; nonce: string }[] = [];
  const marks: { messageId: string; state: string }[] = [];

  const channel = Layer.succeed(MessagingChannel, {
    id: "discord",
    accountId: Effect.succeed("bot"),
    policy: { ownerId: "owner", scopeId: "guild" },
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
    naming: {
      sanitize: (title) => title,
      changes: Stream.never,
      conversation: (input) =>
        Effect.succeed({
          id: input.conversationId ?? `thread-${input.messageId}`,
          managedName: null,
        }),
      current: () => Effect.die("Unexpected name lookup"),
      rename: () => Effect.die("Unexpected rename"),
    },
    ...overrides,
  });

  const { config, store, settings } = harness;
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store));
  const skills = SkillsLive.pipe(Layer.provide(config));
  const model = testModel({ stream, answer: () => response(), requests, capabilities: { tools } });

  const agent = harness.agent(
    (provider, id) => {
      expect([provider, id]).toEqual(["test-provider", "test-model"]);

      return Effect.succeed(model);
    },
    ChatTasksLive.pipe(Layer.provide([tasks, store, skills, settings])),
    Layer.succeed(Pages, pages),
    optionalService(Bash, bash),
  );

  const layer = GatewayLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        channel,
        GatewayRepositoryLive.pipe(Layer.provideMerge(store)),
        TaskDeliveriesLive.pipe(Layer.provide(store)),
        tasks,
        skills,
        agent,
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
        | Gateway
        | Store
        | SqlClient.SqlClient
        | GatewayRepository
        | TaskRepository
        | TaskDeliveries
        | Agent
        | Skills
      >,
    ) =>
      Effect.runPromise(
        program.pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Console.Console, quietConsole),
        ),
      ),
    close: harness.close,
  };
};

test("gateway status stays available while saved operations wait for authenticated identity", async () => {
  const identity = Deferred.makeUnsafe<string>();

  const f = await fixture({
    accountId: Deferred.await(identity),
    status: Effect.succeed({ connected: false }),
  });

  try {
    await f.run(
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const repo = yield* GatewayRepository;
        let accepted = false;

        const pending = yield* gateway.accept(message("1")).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              accepted = true;
            }),
          ),
          Effect.forkChild,
        );

        yield* Effect.yieldNow;
        expect(accepted).toBe(false);
        expect(yield* gateway.connectionStatus).toMatchObject({ connected: false });
        yield* Deferred.succeed(identity, "authenticated-bot");
        yield* Fiber.join(pending);
        expect(accepted).toBe(true);
        expect(yield* repo.next("discord", "authenticated-bot", Date.now())).not.toBeNull();
        expect(yield* gateway.resolveDestination("thread")).toMatchObject({
          account: "authenticated-bot",
        });
      }),
    );
  } finally {
    await f.close();
  }
});

const scheduled = (destination: DeliveryDestination | null) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepository;
    yield* repo.add(
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
    yield* repo.reconcile(0);
    const claimed = (yield* repo.claim(0))!;
    yield* executeOccurrence(repo, claimed);

    return yield* repo.occurrence(claimed.id);
  });

describe.concurrent("Gateway", () => {
  test("when an old approval button arrives through the channel, replies privately without inference", async () => {
    const actions = Effect.runSync(Queue.make<ApprovalAction>());
    const replied = Deferred.makeUnsafe<string>();

    const f = await fixture({
      approvals: {
        actions: Stream.fromQueue(actions),
        send: () => Effect.die("Unexpected prompt"),
        update: () => Effect.die("Unexpected update"),
      },
    });

    try {
      await f.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const running = yield* gateway.run.pipe(Effect.forkChild);
          yield* Queue.offer(actions, {
            requestId: "expired",
            decision: "approve",
            source: message("old-prompt", "thread"),
            reply: (text) => Deferred.succeed(replied, text).pipe(Effect.asVoid),
          });
          expect(yield* Deferred.await(replied)).toStartWith("No matching pending approval");
          expect(f.requests).toEqual([]);
          expect(f.sent).toEqual([]);
          yield* Fiber.interrupt(running);
        }),
      );
    } finally {
      await f.close();
    }
  });

  test.each(
    ["text", "button"].flatMap((transport) =>
      ["approve", "deny", "timeout", "cancel", "revoked", "update-failed"].map((action) => [
        transport,
        action,
      ]),
    ),
  )(
    "when %s command approval ends with %s, binds the decision to the owner and original conversation",
    async (transport, action) => {
      const requested = Effect.runSync(Deferred.make<string>());
      let executed = 0;
      let revoked = false;
      const updates: ApprovalState[] = [];
      const replies: string[] = [];

      const send = (_conversation: string, text: string) =>
        Effect.gen(function* () {
          const id = /\/approve ([a-f0-9-]{36})/.exec(text)?.[1];

          if (id) yield* Deferred.succeed(requested, id);

          return "approval-message";
        });

      const state = await fixture(
        {
          checkAccess: (input) =>
            Effect.suspend(() => {
              if (revoked)
                return Effect.fail(new ChannelError({ reason: "permission", message: "Revoked" }));

              if (
                action === "revoked" &&
                input.messageId === (transport === "button" ? "approval-message" : "decision")
              )
                revoked = true;

              return Effect.void;
            }),
          send,
          approvals: {
            actions: Stream.never,
            send,
            update: (_conversation, _messageId, _id, resultState) =>
              Effect.gen(function* () {
                updates.push(resultState);

                if (action === "update-failed")
                  return yield* Effect.fail(
                    new ChannelError({ reason: "unavailable", message: "Lost update" }),
                  );
              }),
          },
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
            // The send fixture signals before returning its remote ID. Finish delivery first.
            yield* TestClock.adjust(0);

            const click = (
              source = message("approval-message", "thread"),
              decision: "approve" | "deny" = "approve",
            ): ApprovalAction => ({
              requestId: id,
              decision,
              source,
              reply: (text) =>
                Effect.sync(() => {
                  replies.push(text);
                }),
            });

            yield* gateway.accept({
              ...message("stranger", "thread", `/approve ${id}`),
              senderId: "stranger",
            });
            yield* gateway.accept(message("other", "other-thread", `/approve ${id}`));

            if (transport === "button") {
              for (const source of [
                { ...message("approval-message", "thread"), senderId: "stranger" },
                { ...message("approval-message", "thread"), scopeId: "other-guild" },
                { ...message("approval-message", "thread"), parentId: "other-parent" },
                message("approval-message", "other-thread"),
                message("other-message", "thread"),
              ])
                yield* gateway.answerApproval(click(source));

              expect(replies).toHaveLength(5);
              expect(replies.every((text) => !text.startsWith("Approved"))).toBe(true);
            }

            expect(executed).toBe(0);

            if (action === "timeout") yield* TestClock.adjust("2 minutes");
            else if (transport === "button" && action !== "cancel")
              yield* gateway.answerApproval(
                click(undefined, action === "deny" ? "deny" : "approve"),
              );
            else
              yield* gateway.accept(
                message(
                  "decision",
                  "thread",
                  action === "cancel"
                    ? "/cancel"
                    : `/${action === "revoked" || action === "update-failed" ? "approve" : action} ${id}`,
                ),
              );
            yield* Fiber.join(running);
            const approved = action === "approve" || action === "update-failed";
            expect(executed).toBe(approved ? 1 : 0);
            expect(updates).toEqual([
              approved
                ? "approved"
                : action === "deny"
                  ? "denied"
                  : action === "cancel"
                    ? "cancelled"
                    : action === "timeout"
                      ? "expired"
                      : "unavailable",
            ]);
            revoked = false;
            yield* gateway.accept(message("replay", "thread", `/approve ${id}`));
            yield* gateway.answerApproval(click());
            expect(replies.at(-1)).toStartWith("No matching pending approval");
            expect(yield* gateway.processNext).toBe(false);
            expect(executed).toBe(approved ? 1 : 0);
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test.each([false, true])(
    "when cron needs approval with an old queued notice=%j, logs the failure and delivers only a successful retry",
    async (queuedNotice) => {
      let executed = 0;
      let allow = false;
      const errors: string[] = [];

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
        const id = await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            const destination = yield* gateway.resolveDestination("scheduled-thread");

            const item = yield* scheduled(destination).pipe(
              Effect.provideService(Console.Console, {
                ...quietConsole,
                error: (...values) => {
                  errors.push(values.join(" "));
                },
              }),
            );

            expect(item.status).toBe("failed");
            expect(item.reason).toContain("Command needs approval");
            expect(item.reason).toContain("restart-service");
            expect(executed).toBe(0);
            expect(errors[0]).toContain(
              `occurrence=${item.id} failed reason=agent:command-approval-required`,
            );

            if (queuedNotice)
              yield* (yield* GatewayRepository).scheduleResult(
                item.id,
                item.runId!,
                destination,
                ["Saved failure notification"],
                true,
              );
            yield* gateway.deliverNext;

            return item.id;
          }),
        );

        await state.run(Gateway.use((gateway) => gateway.deliverNext));
        expect(state.sent).toEqual([]);
        await state.run(
          Effect.gen(function* () {
            const tasks = yield* TaskRepository;
            expect((yield* tasks.occurrence(id)).status).toBe("failed");
            expect((yield* tasks.occurrence(id)).reason).toContain("restart-service");
            expect(
              (yield* (yield* TaskDeliveries).forOccurrence(id)).map((part) => part.state),
            ).toEqual(queuedNotice ? ["failed"] : []);
            expect(yield* tasks.list()).toHaveLength(1);
            allow = true;
            yield* tasks.retry(id, 0);
            const claimed = (yield* tasks.claim(0))!;
            yield* executeOccurrence(tasks, claimed);
            expect((yield* tasks.occurrence(id)).status).toBe("completed");
            yield* (yield* Gateway).deliverNext;
            expect(
              (yield* (yield* TaskDeliveries).forOccurrence(id)).map((part) => part.state),
            ).toEqual(queuedNotice ? ["failed", "sent"] : ["sent"]);
            expect((yield* (yield* TaskDeliveries).forOccurrence(id)).at(-1)!.runId).toBe(
              (yield* tasks.occurrence(id)).runId!,
            );
          }),
        );
        expect(executed).toBe(1);
        expect(state.sent).toHaveLength(1);
        expect(state.sent[0]).toMatchObject({
          destination: "scheduled-thread",
          text: "Service restarted",
        });
        await state.run(Gateway.use((gateway) => gateway.deliverNext));
        expect(state.sent).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

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
          expect(
            yield* (yield* GatewayRepository).binding("discord", "bot", "guild", "thread"),
          ).toBe(selected);
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
  test.each([
    { delivery: "here", blocked: null },
    { delivery: "here", blocked: "access" },
    { delivery: "home", blocked: null },
    { delivery: "home", blocked: "access" },
    { delivery: { conversationId: "other-channel" }, blocked: null },
    { delivery: { conversationId: "other-channel" }, blocked: "access" },
    { delivery: { conversationId: "foreign-channel" }, blocked: "destination" },
  ] as const)("checks $delivery delivery with $blocked", async ({ delivery, blocked }) => {
    let denied = false;
    let calls = 0;

    const conversationId = Match.value(delivery).pipe(
      Match.when("here", () => "thread-schedule"),
      Match.when("home", () => "home"),
      Match.orElse((target) => target.conversationId),
    );

    const state = await fixture(
      {
        homeConversationId: "home",
        destination: (id) =>
          id === "foreign-channel"
            ? Effect.fail(
                new ChannelError({
                  reason: "permission",
                  message: "Outside the configured server",
                }),
              )
            : Effect.succeed("parent"),
        checkAccess: () =>
          denied
            ? Effect.fail(new ChannelError({ reason: "permission", message: "Access revoked" }))
            : Effect.void,
      },
      () => {
        if (++calls > 1) return response("Task saved");
        denied = blocked === "access";

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
                  delivery,
                  skill: null,
                  after: null,
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
            message("schedule", null, `Create a weekly review and deliver it to ${conversationId}`),
          );
          yield* gateway.processNext;
          const tasks = yield* (yield* TaskRepository).list();

          if (blocked !== null) {
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
                conversationId,
              },
            });
        }),
      );
      expect(calls).toBe(blocked !== null ? 1 : 2);
      expect(state.requests).toHaveLength(2);
    } finally {
      await state.close();
    }
  });

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
          const original = (yield* repo.binding(adapter, "bot", "guild", "chat"))!;
          const selected = message("selected", "chat", "/new --skill review Review Acorn");
          yield* gateway.accept(selected);
          yield* gateway.accept(selected);
          yield* gateway.processNext;
          expect(yield* gateway.processNext).toBe(false);
          const skilled = (yield* repo.binding(adapter, "bot", "guild", "chat"))!;
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
          expect(yield* (yield* GatewayRepository).binding(adapter, "bot", "guild", "chat")).toBe(
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

          const current = (yield* (yield* GatewayRepository).binding(
            adapter,
            "bot",
            "guild",
            "chat",
          ))!;

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
          const original = yield* repo.binding("discord", "bot", "guild", "chat");

          for (const [index, text] of [
            "/new",
            "/new --skill",
            "/new --skill review",
            "/new --skill ../review prompt",
            "/new --skill missing prompt",
          ].entries()) {
            yield* gateway.accept(message(`bad-${index}`, "chat", text));
            yield* gateway.processNext;
            expect(yield* repo.binding("discord", "bot", "guild", "chat")).toBe(original);
          }

          yield* gateway.accept(message("unbound", null, "/new --skill missing prompt"));
          yield* gateway.processNext;
          expect(yield* repo.binding("discord", "bot", "guild", "thread-unbound")).toBeNull();
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
          const sql = yield* SqlClient.SqlClient;
          yield* gateway.accept(message("original", "chat"));
          yield* gateway.processNext;
          const repo = yield* GatewayRepository;
          const original = yield* repo.binding("discord", "bot", "guild", "chat");
          yield* gateway.accept(message("selected", "chat", "/new --skill review First request"));
          yield* sql.unsafe(
            "CREATE TRIGGER fail_binding BEFORE INSERT ON gateway_bindings BEGIN SELECT RAISE(ABORT, 'test'); END",
          );
          expect(yield* gateway.processNext.pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "storage",
          );
          const sessions = yield* (yield* Store).sessions;
          expect(sessions).toHaveLength(2);
          expect(yield* repo.binding("discord", "bot", "guild", "chat")).toBe(original);
          // An abrupt process crash here leaves the input queued instead of running failure cleanup.
          yield* sql.unsafe(
            "UPDATE gateway_inbox SET state = 'queued' WHERE external_id = 'selected'",
          );

          return sessions.find((session) => session.skill?.name === "review")!.id;
        }),
      );

      await rm(path);
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* (yield* SqlClient.SqlClient).unsafe("DROP TRIGGER fail_binding");
          yield* gateway.recover;
          yield* gateway.processNext;
          expect(yield* (yield* GatewayRepository).binding("discord", "bot", "guild", "chat")).toBe(
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

  test.each(["explicit", "home"])(
    "when a saved %s occurrence is delivered after restart, uses its destination snapshot without changing chat",
    async (selection) => {
      const adapter = "test-channel";
      const conversationId = selection === "home" ? "home-channel" : "scheduled-thread";
      const state = await fixture({ id: adapter, homeConversationId: "home-channel" });

      try {
        const occurrence = await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;

            const destination = yield* gateway.resolveDestination(
              selection === "home" ? null : conversationId,
            );

            const item = yield* scheduled(destination);
            const sql = yield* SqlClient.SqlClient;
            // Later configuration and task edits cannot redirect this occurrence.
            yield* sql.unsafe("UPDATE jobs SET destination = ?", [
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
            expect(yield* (yield* TaskDeliveries).forOccurrence(occurrence.id)).toMatchObject([
              { state: "sent", attempts: 0 },
            ]);
            expect((yield* (yield* TaskRepository).occurrence(occurrence.id)).status).toBe(
              "completed",
            );
            expect(
              yield* (yield* GatewayRepository).binding(adapter, "bot", "guild", conversationId),
            ).toBeNull();
          }),
        );
        expect(state.sent).toEqual([
          { destination: conversationId, text: "Answer", nonce: expect.any(String) },
        ]);
        expect(state.requests).toHaveLength(1);
      } finally {
        await state.close();
      }
    },
  );

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
            expect((yield* (yield* TaskRepository).occurrence(item.id)).status).toBe("completed");

            return item;
          }),
        );

        await state.run(
          Effect.gen(function* () {
            const gateway = yield* Gateway;
            yield* gateway.recover;
            yield* TestClock.adjust("1 second");
            expect(yield* gateway.deliverNext).toBe(reason === "unavailable");
            expect((yield* (yield* TaskDeliveries).forOccurrence(occurrence.id))[0]?.state).toBe(
              ({ unavailable: "sent", permission: "failed", uncertain: "uncertain" } as const)[
                reason
              ],
            );
            expect(yield* gateway.processNext).toBe(false);
            const repo = yield* TaskRepository;
            expect((yield* Effect.flip(repo.retry(occurrence.id, 0))).message).toContain(
              "Only unsuccessful occurrences",
            );
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
          expect(
            (yield* (yield* TaskDeliveries).forOccurrence(item.id)).map((part) => part.state),
          ).toEqual(["sending", "pending"]);

          return item;
        }),
      );

      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          expect(yield* gateway.deliverNext).toBe(false);
          expect(
            (yield* (yield* TaskDeliveries).forOccurrence(occurrence.id)).map((part) => part.state),
          ).toEqual(["uncertain", "pending"]);
          expect((yield* (yield* TaskRepository).occurrence(occurrence.id)).status).toBe(
            "completed",
          );
        }),
      );
      expect(attempts).toBe(1);
      expect(state.requests).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test.each(["owner", "guild", "account"])(
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
              account: field === "account" ? "other" : original.account,
            };

            const item = yield* scheduled(destination);
            expect(yield* gateway.deliverNext).toBe(false);
            expect(yield* (yield* TaskDeliveries).forOccurrence(item.id)).toMatchObject([
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
          expect(yield* (yield* TaskDeliveries).forOccurrence(delivered.id)).toMatchObject([
            { state: "failed" },
          ]);
          expect(yield* (yield* TaskDeliveries).forOccurrence(local.id)).toEqual([]);
          expect(yield* gateway.deliverNext).toBe(false);
        }),
      );
      expect(state.sent).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test("when explicit task destinations are supplied, validates them before saving and rejects inaccessible destinations", async () => {
    let parent = "parent";

    const state = await fixture({
      destination: () => Effect.succeed(parent),
      checkAccess: () =>
        parent === "unauthorized"
          ? Effect.fail(new ChannelError({ reason: "permission", message: "Access revoked" }))
          : Effect.void,
    });

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
          expect(yield* repo.list()).toEqual([]);
          expect(yield* gateway.resolveDestination().pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "configuration",
          );
          const resolved = yield* gateway.resolveDestination("saved-thread");

          const added = yield* executeTaskCommand(repo, store, command, 0).pipe(
            Effect.provideService(TaskDestinations, { resolve: () => Effect.succeed(resolved) }),
          );

          expect(added).toHaveProperty("destination", resolved);
          parent = "unauthorized";
          expect(
            yield* gateway.resolveDestination("saved-thread").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          expect(yield* repo.list()).toHaveLength(1);
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
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

  test("when a message is accepted, answers and delivers it without waiting for a fallback timer", async () => {
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
            queued: 1,
            executing: 1,
          });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.processNext;
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
            queued: 0,
            executing: 0,
          });
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
            { ...message("unmentioned"), mentioned: false },
            { ...message("stranger-thread", "existing-thread"), senderId: "stranger" },
            { ...message("unmentioned-thread", "existing-thread"), mentioned: false },
          ])
            yield* gateway.accept(input);
          expect(yield* (yield* Store).sessions).toHaveLength(0);
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({ queued: 0 });
          expect(state.marks).toEqual([]);
          yield* gateway.accept(message("first"));
          yield* gateway.accept(message("first"));
          expect(yield* gateway.processNext).toBe(true);
          yield* gateway.accept({
            ...message("second", "thread-first", "Continue"),
            mentioned: false,
          });
          yield* gateway.processNext;
          yield* gateway.accept({ ...message("third", "existing-thread"), parentId: "other" });
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
          const sql = yield* SqlClient.SqlClient;
          // Simulate a crash after committing the answer but before recording delivery.
          yield* sql.unsafe("DELETE FROM gateway_deliveries");
          yield* sql.unsafe("UPDATE gateway_inbox SET state = 'executing'");
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          yield* gateway.recover;
          yield* gateway.deliverNext;
          yield* gateway.accept(message("interrupted", "thread-first"));
          const repo = yield* GatewayRepository;
          const pending = yield* repo.next("discord", "bot", Date.now());
          expect(pending).not.toBeNull();

          if (pending === null) return;
          const id = yield* repo.binding("discord", "bot", "guild", "thread-first");

          if (id === null) throw new Error("Missing session");
          yield* repo.attach(pending.id, "thread-first", id);
          yield* repo.state(pending.id, "executing");
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
            queued: 0,
            executing: 0,
          });
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
      naming: {
        sanitize: (title) => title,
        changes: Stream.never,
        conversation: () =>
          ++attempts === 1
            ? Effect.fail(
                new ChannelError({ reason: "uncertain", message: "Lost creation acknowledgement" }),
              )
            : Effect.succeed({ id: "recovered-thread", managedName: null }),
        current: () => Effect.die("Unexpected name lookup"),
        rename: () => Effect.die("Unexpected rename"),
      },
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
            expect(yield* (yield* GatewayRepository).status()).toMatchObject({
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
          const sql = yield* SqlClient.SqlClient;

          const saved = yield* sql<{
            readonly text: string;
          }>`SELECT text FROM gateway_deliveries ORDER BY position`;

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

          const firstSession = yield* (yield* GatewayRepository).binding(
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({
            queued: 0,
            executing: 0,
          });
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
          expect(yield* (yield* GatewayRepository).status()).toMatchObject({ queued: 0 });
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
          const old = (yield* repo.binding("discord", "bot", "guild", "managed"))!;
          yield* store.renameSession(old, "Old delayed title");
          const naming = yield* gateway.nameNext.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* gateway.accept(message("replacement", "managed", "/new New prompt"));
          yield* gateway.processNext;
          const replacement = (yield* repo.binding("discord", "bot", "guild", "managed"))!;
          yield* store.renameSession(replacement, "New title");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(naming);
          expect(renames).toEqual([]);
          expect(yield* repo.namedBinding("discord", "bot", "managed")).toMatchObject({
            sessionId: replacement,
            syncedTitle: null,
            namingDisabled: false,
          });
          yield* gateway.deliverNext;
          yield* gateway.nameNext;
          expect(renames).toEqual(["New title"]);
          expect(yield* repo.namedBinding("discord", "bot", "managed")).toMatchObject({
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

      const naming: MessagingChannel["Service"]["naming"] = {
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
              expect(
                (yield* repo.namedBinding("discord", "bot", "thread-title"))?.namingDisabled,
              ).toBe(true);
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
          yield* (yield* GatewayRepository).namePending(
            { adapter: "discord", account: "bot", conversation: "managed", session: session.id },
            "Pending title",
          );
          current = "Pending title";
        }),
      );
      await state.run(
        Effect.gen(function* () {
          yield* (yield* Gateway).nameNext;
          expect(
            yield* (yield* GatewayRepository).namedBinding("discord", "bot", "managed"),
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

// Real time, since the gateway fixture runs on the test clock.
const pause = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)));

const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (yield* check) return;
      yield* pause(5);
    }

    return yield* Effect.die("Timed out waiting for the gateway");
  });

const inboxStates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ externalId: string; state: string }>`
    SELECT external_id, state FROM gateway_inbox ORDER BY id`;

  return Object.fromEntries(rows.map((row) => [row.externalId, row.state]));
});

const settledInbox = (...ids: ReadonlyArray<string>) =>
  until(
    inboxStates.pipe(
      Effect.map((states) =>
        ids.every((id) => ["completed", "cancelled", "failed"].includes(states[id] ?? "")),
      ),
    ),
  );

describe.concurrent("Gateway concurrent requests", () => {
  test("when conversations outnumber slots, runs them at once up to the limit and keeps each in order", async () => {
    const model = gatedStream((prompt) => response(`Answer to ${prompt}`));
    const state = await fixture({}, model.stream, false, { maxConcurrentRequests: 2 });
    const entered = (prompt: string) => Deferred.isDone(model.gate(prompt).entered);
    const release = (prompt: string) => Deferred.succeed(model.gate(prompt).release, undefined);

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* TestClock.adjust("0 millis");
          yield* gateway.accept(message("a1", "thread-a", "A1"));
          yield* gateway.accept(message("b1", "thread-b", "B1"));
          yield* gateway.accept(message("c1", "thread-c", "C1"));
          yield* gateway.accept(message("a2", "thread-a", "A2"));

          yield* Deferred.await(model.gate("A1").entered);
          yield* Deferred.await(model.gate("B1").entered);
          yield* pause(50);
          expect([yield* entered("C1"), yield* entered("A2")]).toEqual([false, false]);

          // A freed slot goes to another conversation, not to the follow-up behind A1.
          yield* release("B1");
          yield* Deferred.await(model.gate("C1").entered);
          yield* pause(50);
          expect(yield* entered("A2")).toBe(false);

          yield* release("A1");
          yield* Deferred.await(model.gate("A2").entered);
          yield* release("C1");
          yield* release("A2");
          yield* settledInbox("a1", "b1", "c1", "a2");
          expect(yield* inboxStates).toEqual({
            a1: "completed",
            b1: "completed",
            c1: "completed",
            a2: "completed",
          });

          const session = yield* (yield* GatewayRepository).binding(
            "discord",
            "bot",
            "guild",
            "thread-a",
          );

          expect(
            (yield* (yield* Store).messages(session!)).map(({ message: saved }) =>
              saved.role === "user" ? saved.text : "answer",
            ),
          ).toEqual(["A1", "answer", "A2", "answer"]);
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when /cancel arrives in one thread, interrupts only that thread's request", async () => {
    const model = gatedStream((prompt) => response(`Answer to ${prompt}`));
    const state = await fixture({}, model.stream, false, { maxConcurrentRequests: 2 });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* TestClock.adjust("0 millis");
          yield* gateway.accept(message("a1", "thread-a", "A1"));
          yield* gateway.accept(message("b1", "thread-b", "B1"));
          yield* Deferred.await(model.gate("A1").entered);
          yield* Deferred.await(model.gate("B1").entered);

          yield* gateway.accept(message("cancel", "thread-a", "/cancel"));
          yield* settledInbox("a1");
          expect(yield* inboxStates).toMatchObject({ a1: "cancelled", b1: "executing" });

          yield* Deferred.succeed(model.gate("B1").release, undefined);
          yield* settledInbox("b1");
          expect(yield* inboxStates).toMatchObject({ a1: "cancelled", b1: "completed" });

          const store = yield* Store;
          const repo = yield* GatewayRepository;

          const runs = (thread: string) =>
            repo
              .binding("discord", "bot", "guild", thread)
              .pipe(Effect.flatMap((session) => store.runs(session!)));

          expect((yield* runs("thread-a")).map((run) => run.status)).toEqual(["interrupted"]);
          expect((yield* runs("thread-b")).map((run) => run.status)).toEqual(["completed"]);
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a CLI send targets a busy gateway session, waits for the gateway request", async () => {
    const model = gatedStream((prompt) => response(`Answer to ${prompt}`));
    const state = await fixture({}, model.stream, false, { maxConcurrentRequests: 2 });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* TestClock.adjust("0 millis");
          yield* gateway.accept(message("a1", "thread-a", "A1"));
          yield* Deferred.await(model.gate("A1").entered);

          const session = yield* (yield* GatewayRepository).binding(
            "discord",
            "bot",
            "guild",
            "thread-a",
          );

          const cli = yield* Stream.runDrain((yield* Agent).send(session!, "CLI")).pipe(
            Effect.forkChild,
          );

          yield* pause(50);
          expect(yield* Deferred.isDone(model.gate("CLI").entered)).toBe(false);

          yield* Deferred.succeed(model.gate("A1").release, undefined);
          yield* Deferred.await(model.gate("CLI").entered);
          yield* Deferred.succeed(model.gate("CLI").release, undefined);
          yield* Fiber.join(cli);
          expect(
            (yield* (yield* Store).messages(session!)).map(({ message: saved }) =>
              saved.role === "user" ? saved.text : "answer",
            ),
          ).toEqual(["A1", "answer", "CLI", "answer"]);
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when the worker stops with several active requests, leaves them for recovery on restart", async () => {
    const model = gatedStream((prompt) => response(`Answer to ${prompt}`));
    const state = await fixture({}, model.stream, false, { maxConcurrentRequests: 2 });

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* TestClock.adjust("0 millis");
          yield* gateway.accept(message("a1", "thread-a", "A1"));
          yield* gateway.accept(message("b1", "thread-b", "B1"));
          yield* Deferred.await(model.gate("A1").entered);
          yield* Deferred.await(model.gate("B1").entered);
          yield* Fiber.interrupt(worker);
          expect(yield* inboxStates).toEqual({ a1: "executing", b1: "executing" });
        }),
      );
      await state.run(
        Effect.gen(function* () {
          yield* (yield* Gateway).recover;
          expect(yield* inboxStates).toEqual({ a1: "completed", b1: "completed" });
          const store = yield* Store;

          for (const session of yield* store.sessions)
            expect((yield* store.runs(session.id)).map((run) => run.status)).toEqual([
              "interrupted",
            ]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when two threads wait for approval, settles each only from its own thread", async () => {
    const prompts = new Map<string, string>();
    const executed: string[] = [];

    const state = await fixture(
      {
        send: (conversation, text) =>
          Effect.sync(() => {
            const id = /\/approve ([a-f0-9-]{36})/.exec(text)?.[1];

            if (id) prompts.set(conversation, id);

            return "sent";
          }),
      },
      (request) => {
        if (request.settings.toolChoice === "none")
          return response(JSON.stringify({ decision: "needs_approval", reason: "Restart" }));

        const last = request.messages.at(-1);

        if (last?.role === "tool") return response("Done");

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
                  command: `restart-${last?.role === "user" ? last.text : ""}`,
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
      { maxConcurrentRequests: 2 },
      undefined,
      {
        run: (request) =>
          Effect.sync(() => {
            executed.push(request.command);

            return { stdout: "done", stderr: "", exitCode: 0, truncated: false };
          }),
      },
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const gateway = yield* Gateway;
          const worker = yield* gateway.run.pipe(Effect.forkChild);
          yield* TestClock.adjust("0 millis");
          yield* gateway.accept(message("a1", "thread-a", "a"));
          yield* gateway.accept(message("b1", "thread-b", "b"));
          yield* until(Effect.sync(() => prompts.size === 2));

          // Thread A's reply cannot settle thread B's approval, and /cancel stops only A.
          yield* gateway.accept(
            message("wrong", "thread-a", `/approve ${prompts.get("thread-b")}`),
          );
          yield* gateway.accept(message("cancel", "thread-a", "/cancel"));
          yield* settledInbox("a1");
          expect(executed).toEqual([]);
          expect(yield* inboxStates).toMatchObject({ a1: "cancelled", b1: "executing" });

          yield* gateway.accept(
            message("right", "thread-b", `/approve ${prompts.get("thread-b")}`),
          );
          yield* settledInbox("b1");
          expect(executed).toEqual(["restart-b"]);
          expect(yield* inboxStates).toMatchObject({ b1: "completed" });
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });
});

test("gateway claims a queued request only once and binds concurrent requests separately", async () => {
  const state = await fixture();

  try {
    await state.run(
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const repo = yield* GatewayRepository;
        const store = yield* Store;
        yield* gateway.accept(message("first", "thread-a"));
        yield* gateway.accept(message("second", "thread-b"));
        const first = (yield* repo.next("discord", "bot", 0))!;

        expect(yield* repo.claim(first.id)).toBe(true);
        expect(yield* repo.claim(first.id)).toBe(false);
        const second = (yield* repo.next("discord", "bot", 0))!;
        expect(second.message.messageId).toBe("second");

        const sessions = yield* Effect.forEach([1, 2], () =>
          store.createSession("test-provider", "test-model"),
        );

        yield* Effect.all(
          [
            repo.attach(first.id, "thread-a", sessions[0]!.id),
            repo.attach(second.id, "thread-b", sessions[1]!.id),
          ],
          { concurrency: "unbounded" },
        );
        expect([
          yield* repo.binding("discord", "bot", "guild", "thread-a"),
          yield* repo.binding("discord", "bot", "guild", "thread-b"),
        ]).toEqual([sessions[0]!.id, sessions[1]!.id]);
      }),
    );
  } finally {
    await state.close();
  }
});
