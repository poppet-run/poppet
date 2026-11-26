import { describe, expect, test } from "bun:test";

import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { GatewayError } from "#src/adapter";
import type {
  ApprovalAction,
  ApprovalSettlement,
  ApprovalState,
  GatewayAdapter,
  IncomingMessage,
} from "#src/adapter";
import type { ApprovalPrompt } from "#src/approval-format";
import { actionApprovals } from "#src/approvals";
import type { ActionApprovals, ApprovalRecords } from "#src/approvals";
import type { SavedApproval } from "#src/repository";

const message: IncomingMessage = {
  messageId: "message",
  scopeId: "guild",
  parentId: "parent",
  conversationId: "thread",
  senderId: "owner",
  text: "Run it",
  mentioned: true,
};

const approval = {
  kind: "bash" as const,
  command: "ls",
  cwd: "/tmp",
  timeoutSeconds: 10,
  reason: "List files",
};

const records = (): ApprovalRecords => {
  const rows = new Map<string, SavedApproval>();

  return {
    openApproval: ({ id, conversationId, parentId }) =>
      Effect.sync(() => {
        rows.set(id, { id, conversationId, parentId, messageId: null, state: "pending" });
      }),
    promptedApproval: (id, messageId) =>
      Effect.sync(() => {
        rows.set(id, { ...rows.get(id)!, messageId });
      }),
    settleApproval: (id, state) =>
      Effect.sync(() => {
        const row = rows.get(id);

        if (row?.state === "pending") {
          rows.set(id, { ...row, state });
        }
      }),
    approval: (id) => Effect.sync(() => rows.get(id) ?? null),
    expireApprovals: () => Effect.succeed([]),
  };
};

const channel = (sent: Array<string>): GatewayAdapter["Service"] => ({
  id: "discord",
  accountId: Effect.succeed("bot"),
  policy: { ownerId: "owner", scopeId: "guild" },
  messages: Stream.never,
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

const prompted = (sent: Array<string>, approvals: ActionApprovals) =>
  Effect.gen(function* () {
    const fiber = yield* approvals
      .request(message, "thread", "run", approval)
      .pipe(Effect.forkChild);

    while (sent.length === 0) {
      yield* Effect.yieldNow;
    }

    const id = /\/approve ([a-f0-9-]{36})/.exec(sent[0]!)?.[1];

    return { fiber, id: id! };
  });

const interactive = () => {
  const sent: Array<string> = [];
  const prompts: Array<ApprovalPrompt> = [];

  const updates: Array<{
    readonly state: ApprovalState;
    readonly settlement?: ApprovalSettlement;
  }> = [];

  const base = channel(sent);

  const adapter: GatewayAdapter["Service"] = {
    ...base,
    approvals: {
      actions: Stream.never,
      send: (conversation, prompt, nonce) =>
        Effect.sync(() => {
          prompts.push(prompt);
        }).pipe(Effect.andThen(base.send(conversation, prompt.fallbackText, nonce))),
      update: (_conversation, _message, _id, state, settlement) =>
        Effect.sync(() => {
          updates.push({ state, ...(settlement && { settlement }) });
        }),
    },
  };

  return { sent, prompts, updates, adapter };
};

const click = (
  id: string,
  replies: Array<string>,
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

describe("actionApprovals", () => {
  test("when a Bash approval contains control characters and markup, renders both fields as escaped data", async () => {
    const sent: Array<string> = [];
    const approvals = actionApprovals(channel(sent), records());

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* approvals
          .request(message, "thread", "run", {
            ...approval,
            command: "echo \u202e```",
            reason: "`approve`\n\u2066",
          })
          .pipe(Effect.forkChild);

        while (sent.length === 0) {
          yield* Effect.yieldNow;
        }

        expect(sent[0]).toContain(String.raw`Reason: \u0060approve\u0060\u000a\u2066`);
        expect(sent[0]).toContain(String.raw`echo \u202e\u0060\u0060\u0060`);
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test.each(["text", "button"])(
    "when the %s answer arrives before the send acknowledgement, waits for complete delivery",
    async (transport) => {
      const { adapter } = interactive();
      const published = Deferred.makeUnsafe<ApprovalPrompt>();
      const acknowledge = Deferred.makeUnsafe<void>();
      const replies: Array<string> = [];

      const approvals = actionApprovals(
        {
          ...adapter,
          approvals: {
            ...adapter.approvals!,
            send: (_conversation, prompt) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(published, prompt);
                yield* Deferred.await(acknowledge);

                return "sent-1";
              }),
          },
        },
        records(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const request = yield* approvals
            .request(message, "thread", "run", approval)
            .pipe(Effect.forkChild);

          const prompt = yield* Deferred.await(published);
          expect(prompt.expiresAt).toBe(120_000);

          const answering = yield* (
            transport === "button"
              ? approvals.answerAction(click(prompt.requestId, replies))
              : approvals
                  .answer("thread", { ...message, text: `/approve ${prompt.requestId}` })
                  .pipe(
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
      const approvals = actionApprovals(adapter, records());
      const replies: Array<string> = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const { fiber, id } = yield* prompted(sent, approvals);

          const [, text] = yield* Effect.all(
            [
              approvals.answerAction(click(id, replies, decision)),
              approvals.answer("thread", {
                ...message,
                text: `/${decision === "approve" ? "deny" : "approve"} ${id}`,
              }),
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
            [...replies, text].filter(
              (reply) => reply.startsWith("No matching") || reply.startsWith("This approval"),
            ),
          ).toHaveLength(1);
          expect(updates).toEqual([
            {
              state: approved ? "approved" : "denied",
              settlement: {
                senderId: "owner",
                text: approved ? "Approved once" : "Denied",
              },
            },
          ]);
        }),
      );
    },
  );

  test("when access checks finish after expiry, the click cannot approve the command", async () => {
    const { sent, updates, adapter } = interactive();
    const checking = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();

    const approvals = actionApprovals(
      {
        ...adapter,
        checkAccess: (source) =>
          source.messageId === "sent-1"
            ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      },
      records(),
    );

    const replies: Array<string> = [];

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
        expect(updates).toEqual([{ state: "expired", settlement: { text: "Expired" } }]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("when the worker restarts, the new approval manager rejects old buttons and text IDs", async () => {
    const { sent, adapter } = interactive();
    const saved = records();
    const original = actionApprovals(adapter, saved);
    const replies: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, original);
        const restarted = actionApprovals(adapter, saved);
        yield* restarted.answerAction(click(id, replies));
        expect(replies[0]).toStartWith("No matching pending approval");
        expect(
          yield* restarted.answer("thread", { ...message, text: `/approve ${id}` }),
        ).toStartWith("No matching pending approval");
        yield* Fiber.interrupt(fiber);
      }),
    );
  });

  test("when the private confirmation fails, the accepted decision remains consumed", async () => {
    const { sent, adapter } = interactive();
    const approvals = actionApprovals(adapter, records());

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);
        yield* approvals.answerAction({
          ...click(id, []),
          reply: () =>
            Effect.fail(new GatewayError({ reason: "unavailable", message: "Lost reply" })),
        });
        expect(yield* Fiber.join(fiber)).toBe(true);
        expect(yield* approvals.answer("thread", { ...message, text: `/approve ${id}` })).toBe(
          "This approval was already answered: Approved once.",
        );
      }),
    );
  });

  test("when a status update hangs, cancellation completes after the update deadline", async () => {
    const { sent, adapter } = interactive();
    const updating = Deferred.makeUnsafe<void>();

    const approvals = actionApprovals(
      {
        ...adapter,
        approvals: {
          ...adapter.approvals!,
          update: () => Deferred.succeed(updating, undefined).pipe(Effect.andThen(Effect.never)),
        },
      },
      records(),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);
        yield* TestClock.adjust(0);
        const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Deferred.await(updating);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(cancelling);
        expect(
          yield* approvals.answer("thread", { ...message, text: `/approve ${id}` }),
        ).toStartWith("This approval has ended: Cancelled.");
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test.each([false, true])(
    "when a long prompt on an interactive adapter has failed delivery=%j, sends a truncated prompt with full canonical payload",
    async (fail) => {
      const { prompts, adapter } = interactive();
      const ready = Deferred.makeUnsafe<void>();

      const approvals = actionApprovals(
        {
          ...adapter,
          approvals: {
            ...adapter.approvals!,
            send: (_conversation, prompt) =>
              fail
                ? Effect.fail(new GatewayError({ reason: "unavailable", message: "Send failed" }))
                : Effect.sync(() => {
                    prompts.push(prompt);
                    Deferred.doneUnsafe(ready, Effect.void);

                    return "controls";
                  }),
          },
        },
        records(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const command = "echo `printf 😀` ".repeat(400);

          const fiber = yield* approvals
            .request(message, "thread", "run", { ...approval, command })
            .pipe(Effect.forkChild);

          if (fail) {
            expect(yield* Fiber.join(fiber).pipe(Effect.result)).toHaveProperty(
              "failure.reason",
              "command-approval-required",
            );
            expect(prompts).toEqual([]);
          } else {
            yield* Deferred.await(ready);
            expect(prompts).toHaveLength(1);
            expect(prompts[0]!.truncated).toBe(true);
            expect(JSON.parse(prompts[0]!.canonicalPayload)).toEqual({
              command,
              cwd: approval.cwd,
              timeoutSeconds: approval.timeoutSeconds,
            });
            expect(prompts[0]!.fallbackText).toContain(
              `\`/approve ${prompts[0]!.requestId}\` or \`/deny ${prompts[0]!.requestId}\``,
            );
            yield* approvals.answer("thread", {
              ...message,
              text: `/deny ${prompts[0]!.requestId}`,
            });
            expect(yield* Fiber.join(fiber)).toBe(false);
          }
        }),
      );
    },
  );

  test("when MCP invocation details cannot be delivered on a text-only adapter, leaves no approval to settle", async () => {
    const sent: Array<string> = [];
    const base = { ...channel(sent), textLimit: 300 };

    const approvals = actionApprovals(
      {
        ...base,
        send: (_conversation, part) => {
          if (sent.length === 1) {
            return Effect.fail(new GatewayError({ reason: "unavailable", message: "Send failed" }));
          }

          return base.send("thread", part, "summary");
        },
      },
      records(),
    );

    let recorded = false;

    const result = await Effect.runPromise(
      approvals
        .request(
          message,
          "thread",
          "run",
          {
            kind: "mcp",
            invocation: JSON.stringify({ arguments: { text: "x".repeat(4000) } }),
            target: "Docs/42",
            effects: "Replace the document text",
            reason: "Overwrites an existing record",
          },
          () =>
            Effect.sync(() => {
              recorded = true;
            }),
        )
        .pipe(Effect.flip),
    );

    expect(result.reason).toBe("mcp-approval-required");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("MCP action approval required");
    expect(sent[0]).not.toContain("/approve");
    expect(recorded).toBe(false);
  });

  test.each([
    ["approve", true, "Approved this exact command once."],
    ["deny", false, "Command denied."],
  ])("when the owner replies /%s, settles the request once", async (action, approved, reply) => {
    const sent: Array<string> = [];
    const approvals = actionApprovals(channel(sent), records());

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);

        expect(sent[0]).toContain("Bash approval required");
        expect(sent[0]).toContain("```sh\nls\n```");
        expect(sent[0]).toContain("Working directory: `/tmp`");
        expect(sent[0]).toContain("Timeout: 10 seconds");
        expect(yield* approvals.answer("thread", { ...message, text: `/${action} ${id}` })).toBe(
          reply,
        );
        expect(yield* Fiber.join(fiber)).toBe(approved);
        expect(
          yield* approvals.answer("thread", { ...message, text: `/${action} ${id}` }),
        ).toStartWith("This approval was already answered");
      }),
    );
  });

  test("when a reply comes from another conversation or names no request, leaves it pending", async () => {
    const sent: Array<string> = [];
    const approvals = actionApprovals(channel(sent), records());

    await Effect.runPromise(
      Effect.gen(function* () {
        const { fiber, id } = yield* prompted(sent, approvals);

        for (const [conversation, text] of [
          ["other", `/approve ${id}`],
          ["thread", "/approve"],
          ["thread", `/approve ${id} now`],
        ]) {
          expect(
            yield* approvals.answer(conversation!, {
              ...message,
              conversationId: conversation!,
              text: text!,
            }),
          ).toStartWith("No matching pending approval");
        }

        expect(yield* approvals.answer("thread", { ...message, text: `/approve ${id}` })).toBe(
          "Approved this exact command once.",
        );
        expect(yield* Fiber.join(fiber)).toBe(true);
      }),
    );
  });
});
