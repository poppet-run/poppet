import { describe, expect, test } from "bun:test";

import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { commandApprovals, type CommandApprovals } from "#src/approvals";
import {
  ChannelError,
  type ApprovalAction,
  type ApprovalState,
  type IncomingMessage,
  type MessagingChannel,
} from "#src/channel";

const message: IncomingMessage = {
  messageId: "message",
  scopeId: "guild",
  parentId: "parent",
  conversationId: "thread",
  senderId: "owner",
  text: "Run it",
  mentioned: true,
};

const approval = { command: "ls", cwd: "/tmp", timeoutSeconds: 10, reason: "List files" };

const channel = (sent: string[]): MessagingChannel["Service"] => ({
  id: "discord",
  accountId: Effect.succeed("bot"),
  policy: { ownerId: "owner", scopeId: "guild" },
  messages: Stream.never,
  conversation: () => Effect.die("Unexpected conversation"),
  checkAccess: () => Effect.void,
  destination: () => Effect.die("Unexpected destination"),
  typing: () => Effect.void,
  mark: () => Effect.void,
  send: (_, text) =>
    Effect.sync(() => {
      sent.push(text);

      return `sent-${sent.length}`;
    }),
  status: Effect.succeed({}),
  textLimit: 2000,
  naming: {
    sanitize: (title) => title,
    changes: Stream.never,
    conversation: () => Effect.die("Unexpected conversation"),
    current: () => Effect.die("Unexpected name lookup"),
    rename: () => Effect.die("Unexpected rename"),
  },
});

// Starts a request and returns it once its prompt has been sent.
const prompted = (sent: string[], approvals: CommandApprovals) =>
  Effect.gen(function* () {
    const fiber = yield* approvals.request(message, "thread", approval).pipe(Effect.forkChild);

    while (sent.length === 0) yield* Effect.yieldNow;
    const id = /Reply \/approve ([a-f0-9-]{36})/.exec(sent[0]!)?.[1];

    return { fiber, id: id! };
  });

const interactive = () => {
  const sent: string[] = [];
  const updates: ApprovalState[] = [];
  const base = channel(sent);

  const adapter: MessagingChannel["Service"] = {
    ...base,
    approvals: {
      actions: Stream.never,
      send: base.send,
      update: (_conversation, _message, _id, state) =>
        Effect.sync(() => {
          updates.push(state);
        }),
    },
  };

  return { sent, updates, adapter };
};

const click = (
  id: string,
  replies: string[],
  decision: "approve" | "deny" = "approve",
): ApprovalAction => ({
  requestId: id,
  decision,
  source: { ...message, messageId: "sent-1" },
  reply: (text) =>
    Effect.sync(() => {
      replies.push(text);
    }),
});

describe("commandApprovals", () => {
  test.each(["text", "button"])(
    "when the %s answer arrives before the send acknowledgement, waits for complete delivery",
    async (transport) => {
      const { adapter } = interactive();
      const published = Deferred.makeUnsafe<string>();
      const acknowledge = Deferred.makeUnsafe<void>();
      const replies: string[] = [];

      const approvals = commandApprovals({
        ...adapter,
        approvals: {
          ...adapter.approvals!,
          send: (_conversation, _text, _nonce, id) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(published, id);
              yield* Deferred.await(acknowledge);

              return "sent-1";
            }),
        },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const request = yield* approvals
            .request(message, "thread", approval)
            .pipe(Effect.forkChild);

          const id = yield* Deferred.await(published);

          const answering = yield* (
            transport === "button"
              ? approvals.answerAction(click(id, replies))
              : approvals.answer("thread", `/approve ${id}`).pipe(
                  Effect.tap((text) =>
                    Effect.sync(() => {
                      replies.push(text);
                    }),
                  ),
                )
          ).pipe(Effect.forkChild);

          yield* TestClock.adjust(0);
          expect(replies).toEqual([]);
          yield* Deferred.succeed(acknowledge, undefined);
          yield* Fiber.join(answering);
          expect(yield* Fiber.join(request)).toBe(true);
          expect(replies).toEqual(["Approved this exact command once."]);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );

  test.each(["approve", "deny"] as const)(
    "when the %s button races the opposite text command, only one decision wins",
    async (decision) => {
      const { sent, updates, adapter } = interactive();
      const approvals = commandApprovals(adapter);
      const replies: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const { fiber, id } = yield* prompted(sent, approvals);

          const [, text] = yield* Effect.all(
            [
              approvals.answerAction(click(id, replies, decision)),
              approvals.answer("thread", `/${decision === "approve" ? "deny" : "approve"} ${id}`),
            ],
            { concurrency: "unbounded" },
          );

          const approved = yield* Fiber.join(fiber);
          expect(
            [...replies, text].filter(
              (reply) =>
                reply === "Approved this exact command once." || reply === "Command denied.",
            ),
          ).toEqual([approved ? "Approved this exact command once." : "Command denied."]);
          expect(
            [...replies, text].filter((reply) => reply.startsWith("No matching")),
          ).toHaveLength(1);
          expect(updates).toEqual([approved ? "approved" : "denied"]);
        }),
      );
    },
  );

  test("when access checks finish after expiry, the click cannot approve the command", async () => {
    const { sent, updates, adapter } = interactive();
    const checking = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();

    const approvals = commandApprovals({
      ...adapter,
      checkAccess: (source) =>
        source.messageId === "sent-1"
          ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
    });

    const replies: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);
        const answering = yield* approvals.answerAction(click(id, replies)).pipe(Effect.forkChild);
        yield* Deferred.await(checking);
        yield* TestClock.adjust("2 minutes");
        expect(yield* Fiber.join(fiber).pipe(Effect.result)).toHaveProperty(
          "failure.reason",
          "command-approval-required",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(answering);
        expect(replies[0]).toStartWith("No matching pending approval");
        expect(updates).toEqual(["expired"]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("when the worker restarts, the new approval manager rejects old buttons and text IDs", async () => {
    const { sent, adapter } = interactive();
    const original = commandApprovals(adapter);
    const replies: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, original);
        const restarted = commandApprovals(adapter);
        yield* restarted.answerAction(click(id, replies));
        expect(replies[0]).toStartWith("No matching pending approval");
        expect(yield* restarted.answer("thread", `/approve ${id}`)).toStartWith(
          "No matching pending approval",
        );
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test("when the private confirmation fails, the accepted decision remains consumed", async () => {
    const { sent, adapter } = interactive();
    const approvals = commandApprovals(adapter);

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);
        yield* approvals.answerAction({
          ...click(id, []),
          reply: () =>
            Effect.fail(new ChannelError({ reason: "unavailable", message: "Lost reply" })),
        });
        expect(yield* Fiber.join(fiber)).toBe(true);
        expect(yield* approvals.answer("thread", `/approve ${id}`)).toStartWith(
          "No matching pending approval",
        );
      }),
    );
  });

  test("when a status update hangs, cancellation completes after the update deadline", async () => {
    const { sent, adapter } = interactive();
    const updating = Deferred.makeUnsafe<void>();

    const approvals = commandApprovals({
      ...adapter,
      approvals: {
        ...adapter.approvals!,
        update: () => Deferred.succeed(updating, undefined).pipe(Effect.andThen(Effect.never)),
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);
        yield* TestClock.adjust(0);
        const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Deferred.await(updating);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(cancelling);
        expect(yield* approvals.answer("thread", `/approve ${id}`)).toStartWith(
          "No matching pending approval",
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test.each([false, true])(
    "when a long prompt has failed delivery=%j, only a complete invocation can get buttons",
    async (fail) => {
      const { sent, adapter } = interactive();
      const buttons: { text: string; id: string }[] = [];
      const ready = Deferred.makeUnsafe<void>();

      const approvals = commandApprovals({
        ...adapter,
        send: (conversation, text, nonce) =>
          sent.length === 1 && fail
            ? Effect.fail(new ChannelError({ reason: "unavailable", message: "Send failed" }))
            : adapter.send(conversation, text, nonce),
        approvals: {
          ...adapter.approvals!,
          send: (_conversation, text, _nonce, id) =>
            Effect.sync(() => {
              buttons.push({ text, id });
              Deferred.doneUnsafe(ready, Effect.void);

              return "controls";
            }),
        },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const command = "echo 😀 ".repeat(700);

          const fiber = yield* approvals
            .request(message, "thread", { ...approval, command })
            .pipe(Effect.forkChild);

          if (fail) {
            expect(yield* Fiber.join(fiber).pipe(Effect.result)).toHaveProperty(
              "failure.reason",
              "command-approval-required",
            );
            expect(buttons).toEqual([]);
          } else {
            yield* Deferred.await(ready);
            expect(sent.every((part) => part.length <= adapter.textLimit)).toBe(true);
            expect(sent.join("")).toContain(
              JSON.stringify({
                command,
                cwd: approval.cwd,
                timeoutSeconds: approval.timeoutSeconds,
              }),
            );
            expect(buttons).toHaveLength(1);
            expect(buttons[0]!.text).toContain(
              `/approve ${buttons[0]!.id} or /deny ${buttons[0]!.id}`,
            );
            yield* approvals.answer("thread", `/deny ${buttons[0]!.id}`);
            expect(yield* Fiber.join(fiber)).toBe(false);
          }
        }),
      );
    },
  );

  test.each([
    ["approve", true, "Approved this exact command once."],
    ["deny", false, "Command denied."],
  ])("when the owner replies /%s, settles the request once", async (action, approved, reply) => {
    const sent: string[] = [];
    const approvals = commandApprovals(channel(sent));

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);

        expect(yield* approvals.answer("thread", `/${action} ${id}`)).toBe(reply);
        expect(yield* Fiber.join(fiber)).toBe(approved);
        expect(yield* approvals.answer("thread", `/${action} ${id}`)).toStartWith(
          "No matching pending approval",
        );
      }),
    );
  });

  test("when a reply comes from another conversation or names no request, leaves it pending", async () => {
    const sent: string[] = [];
    const approvals = commandApprovals(channel(sent));

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);

        for (const [conversation, text] of [
          ["other", `/approve ${id}`],
          ["thread", "/approve"],
          ["thread", `/approve ${id} now`],
        ])
          expect(yield* approvals.answer(conversation!, text!)).toStartWith(
            "No matching pending approval",
          );

        expect(yield* approvals.answer("thread", `/approve ${id}`)).toBe(
          "Approved this exact command once.",
        );
        expect(yield* Fiber.join(fiber)).toBe(true);
      }),
    );
  });
});
