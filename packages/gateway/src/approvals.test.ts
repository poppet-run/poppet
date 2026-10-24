import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Stream } from "effect";

import { commandApprovals, type CommandApprovals } from "#src/approvals";
import type { IncomingMessage, MessagingChannel } from "#src/channel";

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

describe("commandApprovals", () => {
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
