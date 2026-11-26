import { createHash } from "node:crypto";

import type { ActionApproval } from "@poppet/agent";
import type { Approval } from "@poppet/store";
import { Effect, Option, Schema } from "effect";

import type { ApprovalAction, ApprovalState, IncomingMessage } from "#src/adapter";
import {
  formatApprovalMessages,
  formatApprovalPrompt,
  formatApprovalStatus,
} from "#src/approval-format";
import { authorized, finish, mark, wake } from "#src/context";
import type { GatewayContext } from "#src/context";
import { answer as runAnswer } from "#src/replies";
import type { Inbox, SavedApproval } from "#src/repository";

const missing =
  "No matching pending approval in this conversation. It may have expired; request the operation again.";

const expiredReply =
  "The approval expired. Nothing was executed; send the request again if it is still needed.";

const ActionRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bash"),
    command: Schema.String,
    cwd: Schema.String,
    timeoutSeconds: Schema.Number,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    invocation: Schema.String,
    target: Schema.String,
    effects: Schema.String,
    reason: Schema.String,
  }),
]);

const ScheduledRequester = Schema.Struct({
  surface: Schema.Literal("scheduled"),
  adapter: Schema.String,
  account: Schema.String,
  ownerId: Schema.String,
  scopeId: Schema.String,
  parentId: Schema.String,
  conversationId: Schema.String,
});

const ended = (state: ApprovalState) =>
  state === "approved" || state === "denied"
    ? `This approval was already answered: ${formatApprovalStatus(state)}.`
    : `This approval has ended: ${formatApprovalStatus(state)}. Nothing was executed; request the operation again.`;

const decided = (kind: Approval["kind"], approved: boolean) => {
  if (kind === "mcp") {
    return approved ? "Approved this exact MCP action once." : "MCP action denied.";
  }

  return approved ? "Approved this exact command once." : "Command denied.";
};

export const actionApprovals = (context: GatewayContext) => {
  const { adapter, repo, store, clock } = context;

  // Posts the prompt for a waiting run. Safe to repeat: the row and nonces stay the same.
  const postPrompt = (
    target: {
      readonly account: string;
      readonly conversationId: string;
      readonly parentId: string;
      readonly runId: string;
    },
    approval: Approval,
  ) =>
    Effect.gen(function* () {
      const request: ActionApproval = yield* Schema.decodeUnknownEffect(ActionRequest)(
        approval.request,
      ).pipe(Effect.orDie);

      yield* repo.openApproval({
        id: approval.id,
        adapter: adapter.id,
        account: target.account,
        conversationId: target.conversationId,
        parentId: target.parentId,
        runId: target.runId,
        kind: approval.kind,
        expiresAt: approval.expiresAt,
      });

      const prompt = formatApprovalPrompt({
        requestId: approval.id,
        approval: request,
        expiresAt: approval.expiresAt,
        expiresAfterSeconds: Math.round((approval.expiresAt - approval.createdAt) / 1000),
      });

      const nonce = (index: number) =>
        createHash("sha256").update(`${approval.id}-${index}`).digest("hex").slice(0, 24);

      let promptId: string | null = null;

      if (adapter.approvals) {
        promptId = yield* adapter.approvals.send(target.conversationId, prompt, nonce(0));
      } else {
        for (const [index, part] of formatApprovalMessages(prompt, adapter.textLimit).entries()) {
          promptId = yield* adapter.send(target.conversationId, part, nonce(index));
        }
      }

      if (promptId !== null) {
        yield* repo.promptedApproval(approval.id, promptId);
      }
    });

  const post = (entry: Inbox, conversation: string, approval: Approval) =>
    postPrompt(
      {
        account: entry.account,
        conversationId: conversation,
        parentId: entry.message.parentId,
        runId: entry.runId,
      },
      approval,
    );

  // Shows a settled approval on its prompt once. A failed update cannot reopen it.
  const render = (id: string, state: ApprovalState, senderId?: string) =>
    Effect.gen(function* () {
      const saved = yield* repo.approval(id);

      if (saved?.state !== "pending") {
        return;
      }

      yield* repo.settleApproval(id, state);

      if (saved.messageId === null || !adapter.approvals) {
        return;
      }

      yield* adapter.approvals
        .update(saved.conversationId, saved.messageId, id, state, {
          ...(senderId !== undefined &&
            (state === "approved" || state === "denied") && { senderId }),
          text: formatApprovalStatus(state),
        })
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.catch(() => Effect.void),
        );
    });

  const renderApproval = (approval: Approval) =>
    approval.state === "pending"
      ? Effect.void
      : render(approval.id, approval.state, approval.decidedBy?.senderId);

  // Ends a run that is waiting or ready to resume, then shows the outcome on its prompt.
  const end = (runId: string, reason: "cancelled" | "superseded") =>
    Effect.gen(function* () {
      const run = yield* store.run(runId);

      if (run?.status === "waiting" || run?.status === "running") {
        yield* store.finishRun(runId, { status: "interrupted", reason });
      }

      const approval = yield* store.latestApproval(runId);

      if (approval !== null) {
        yield* renderApproval(approval);
      }
    });

  // Supersedes a waiting run in this session before a new message runs there.
  const supersede = (sessionId: string) =>
    Effect.gen(function* () {
      for (const run of yield* store.runs(sessionId)) {
        if (run.status !== "waiting") {
          continue;
        }

        yield* end(run.id, "superseded");
        const entry = yield* repo.byRun(run.id);

        if (entry !== null) {
          yield* repo.state(entry.id, "cancelled");
          yield* mark(context, entry.message, "stopped");
        }
      }
    });

  // Brings waiting requests and open prompts in line with the store, after a restart or
  // an expiry sweep.
  const reconcile = Effect.gen(function* () {
    const account = yield* adapter.accountId;

    for (const entry of yield* repo.waiting(adapter.id, account)) {
      const run = yield* store.run(entry.runId);
      const approval = yield* store.latestApproval(entry.runId);

      if (run?.status === "waiting" && approval !== null && entry.conversationId !== null) {
        const saved = yield* repo.approval(approval.id);

        if (saved?.messageId === null || saved === null) {
          yield* post(entry, entry.conversationId, approval).pipe(
            Effect.catchTag("GatewayError", (error) =>
              Effect.logWarning("approval prompt post failed; will retry").pipe(
                Effect.annotateLogs({ error: error.message }),
              ),
            ),
          );
        }
      } else if (
        run?.status === "running" &&
        (approval?.state === "approved" || approval?.state === "denied")
      ) {
        yield* repo.requeue(entry.runId);
        yield* wake(context.wakes.inbox);
      } else {
        const text = approval?.state === "expired" || run === null ? expiredReply : runAnswer(run);

        yield* finish(context, entry.id, text, "failed");
        yield* mark(context, entry.message, "stopped");
      }
    }

    for (const id of yield* repo.scheduledApprovals(adapter.id, account)) {
      const approval = yield* store.approval(id);

      if (approval?.state !== "pending") {
        continue;
      }

      const decoded = Schema.decodeUnknownOption(ScheduledRequester)(approval.requester);

      if (Option.isNone(decoded)) {
        continue;
      }

      const route = decoded.value;

      if (route.ownerId !== adapter.policy.ownerId || route.scopeId !== adapter.policy.scopeId) {
        continue;
      }

      const saved = yield* repo.approval(approval.id);

      if (saved === null || saved.messageId === null) {
        yield* postPrompt(
          {
            account,
            conversationId: route.conversationId,
            parentId: route.parentId,
            runId: approval.runId,
          },
          approval,
        ).pipe(
          Effect.catchTag("GatewayError", (error) =>
            Effect.logWarning("scheduled approval prompt post failed; will retry").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          ),
        );
      }
    }

    for (const prompt of yield* repo.openPrompts(adapter.id, account)) {
      const approval = yield* store.approval(prompt.id);

      if (approval === null) {
        yield* render(prompt.id, "expired");
      } else {
        yield* renderApproval(approval);
      }
    }
  });

  const sweep = store.expireApprovals.pipe(Effect.andThen(reconcile));

  const decide = (
    requestId: string,
    source: IncomingMessage,
    approve: boolean,
    saved: SavedApproval | null,
  ) =>
    Effect.gen(function* () {
      if (saved === null) {
        return missing;
      }

      const approval = yield* store.decideApproval(requestId, {
        decision: approve ? "approved" : "denied",
        adapter: adapter.id,
        senderId: source.senderId,
        at: clock.currentTimeMillisUnsafe(),
      });

      if (approval === null) {
        yield* sweep;
        const current = yield* store.approval(requestId);

        const state =
          current !== null && current.state !== "pending"
            ? current.state
            : saved.state !== "pending"
              ? saved.state
              : null;

        return state === null ? missing : ended(state);
      }

      yield* repo.requeue(approval.runId);
      yield* wake(context.wakes.inbox);
      yield* renderApproval(approval);

      return decided(approval.kind, approve);
    });

  // Finds the saved prompt only when the answer comes from its own conversation and parent.
  const promptFor = (requestId: string, source: IncomingMessage, button: boolean) =>
    repo
      .approval(requestId)
      .pipe(
        Effect.map((saved) =>
          saved === null ||
          saved.conversationId !== source.conversationId ||
          saved.parentId !== source.parentId ||
          (button && saved.messageId !== source.messageId)
            ? null
            : saved,
        ),
      );

  const answer = (conversation: string, source: IncomingMessage) =>
    Effect.gen(function* () {
      if (!authorized(adapter.policy, source)) {
        return "Only the configured owner can answer this approval.";
      }

      const reply = /^\/(approve|deny) ([a-f0-9-]{36})$/.exec(source.text.trim());
      const requestId = reply?.[2];

      if (reply === null || requestId === undefined || source.conversationId !== conversation) {
        return missing;
      }

      return yield* decide(
        requestId,
        source,
        reply[1] === "approve",
        yield* promptFor(requestId, source, false),
      );
    });

  const answerAction = (action: ApprovalAction) =>
    Effect.gen(function* () {
      const { source, requestId } = action;

      if (!authorized(adapter.policy, source)) {
        return "Only the configured owner can answer this approval.";
      }

      const saved = yield* promptFor(requestId, source, true);

      if (saved !== null) {
        yield* adapter.checkAccess(source, saved.conversationId);
      }

      return yield* decide(requestId, source, action.decision === "approve", saved);
    }).pipe(
      Effect.catchTag("GatewayError", () =>
        Effect.succeed(
          "Approval could not be confirmed. Check access and try again before it expires.",
        ),
      ),
      Effect.flatMap(action.reply),
      Effect.catchTag("GatewayError", () => Effect.void),
    );

  return { post, end, supersede, reconcile, sweep, answer, answerAction };
};

export type ActionApprovals = ReturnType<typeof actionApprovals>;
