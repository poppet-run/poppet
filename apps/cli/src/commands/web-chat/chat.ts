import { createHash } from "node:crypto";

import { Agent } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { formatApprovalPrompt, gatewaySchema } from "@poppet/gateway";
import { outputText } from "@poppet/provider";
import { Store, decodeRow, decodeRows, migrate, packageSchema } from "@poppet/store";
import { taskSchema } from "@poppet/tasks";
import type {
  SessionList,
  ChatApproval,
  ChatSession,
  ChatSnapshot,
  Receipt,
  Submission,
} from "@poppet/web/protocol";
import {
  Clock,
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { ActionRequest } from "#src/commands/approvals/approvals";
import { removeSessions } from "#src/commands/chat/chat";

export class WebChatError extends Data.TaggedError("WebChatError")<{
  readonly status: number;
  readonly message: string;
}> {}

export const SubmissionBody = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  sessionId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))),
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32_768),
    Schema.makeFilter((text) => text.trim().length > 0),
  ),
});

const ReceiptRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  fingerprint: Schema.String,
  status: Schema.Literals(["accepted", "completed", "failed", "interrupted"]),
  error: Schema.NullOr(Schema.String),
});

const toReceipt = ({ id, sessionId, status, error }: typeof ReceiptRow.Type): Receipt => ({
  id,
  sessionId,
  status,
  error,
});

export const webSchema = packageSchema("web_chat_migrations", {
  "1_submissions": [
    `CREATE TABLE web_chat_submissions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    ) STRICT`,
    "CREATE INDEX web_chat_session ON web_chat_submissions(session_id)",
  ],
  "2_session_removal": [
    `CREATE TRIGGER detach_web_chat_sessions BEFORE DELETE ON sessions
    BEGIN
      DELETE FROM web_chat_submissions WHERE session_id = OLD.id;
    END`,
  ],
});

interface ActiveReply {
  id: string;
  input: string;
  text: string;
  previousMessageId: number;
  fiber: Fiber.Fiber<void> | null;
}

const summary = (session: ChatSession): ChatSession => ({
  id: session.id,
  title: session.title,
  provider: session.provider,
  model: session.model,
  updatedAt: session.updatedAt,
});

const makeWebChat = Effect.gen(function* () {
  const store = yield* Store;
  const agent = yield* Agent;
  const config = yield* AppConfig;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const submissions = yield* Semaphore.make(1);
  const active = new Map<string, ActiveReply>();

  yield* migrate(taskSchema);
  yield* migrate(gatewaySchema);
  yield* migrate(webSchema);
  yield* sql`UPDATE web_chat_submissions SET
    status = COALESCE((SELECT status FROM runs WHERE runs.id = web_chat_submissions.id AND status IN ('completed', 'failed', 'interrupted')), 'interrupted'),
    error = CASE WHEN EXISTS (SELECT 1 FROM runs WHERE runs.id = web_chat_submissions.id AND status = 'completed') THEN NULL
      ELSE 'Worker restarted. Inspect the conversation before sending again.' END
    WHERE status = 'accepted' AND id NOT IN (
      SELECT a.run_id FROM approvals a JOIN tool_calls c USING(run_id, call_id)
      WHERE c.status = 'pending' AND a.state IN ('pending','approved','denied')
    )`;

  const receipt = (id: string) =>
    sql`SELECT * FROM web_chat_submissions WHERE id = ${id}`.pipe(decodeRow(ReceiptRow));

  const snapshot = (id: string) =>
    Effect.gen(function* () {
      const session = yield* store.session(id);

      if (!session) {
        return yield* new WebChatError({ status: 404, message: "Conversation not found." });
      }

      const messages = yield* store.messages(id);

      const receipts =
        yield* sql`SELECT * FROM web_chat_submissions WHERE session_id = ${id} ORDER BY rowid`.pipe(
          decodeRows(ReceiptRow),
        );

      const running = active.get(id);

      const cards = new Map<string, ChatApproval>();

      const ids = yield* sql<{
        id: string;
      }>`SELECT a.id FROM approvals a JOIN web_chat_submissions w ON a.run_id = w.id WHERE w.session_id = ${id}`;

      for (const row of ids) {
        const approval = yield* store.approval(row.id);

        if (!approval) {
          continue;
        }

        const request = yield* Schema.decodeUnknownEffect(ActionRequest)(approval.request);

        const prompt = formatApprovalPrompt({
          requestId: approval.id,
          approval: request,
          expiresAt: approval.expiresAt,
          expiresAfterSeconds: (approval.expiresAt - approval.createdAt) / 1000,
        });

        cards.set(JSON.stringify([approval.runId, approval.callId]), {
          id: approval.id,
          title: prompt.title,
          summary: prompt.summary,
          fields: prompt.fields,
          ...(prompt.args && { args: prompt.args }),
          ...(prompt.codeBlock && { codeBlock: prompt.codeBlock }),
          ...(prompt.truncated && { details: prompt.canonicalPayload }),
          state: approval.state,
          actor: approval.decidedBy
            ? `${approval.decidedBy.adapter} (${approval.decidedBy.senderId})`
            : null,
        });
      }

      return {
        session: summary(session),
        messages: messages.flatMap<ChatSnapshot["messages"][number]>((entry) => {
          if (entry.message.role === "user") {
            return [
              { id: entry.id, runId: entry.runId, role: "user" as const, text: entry.message.text },
            ];
          }

          if (entry.message.role === "assistant") {
            if (running && entry.runId === running.id && entry.id > running.previousMessageId) {
              return [];
            }

            const text = outputText(entry.message.output);

            const approvals = entry.message.output.flatMap((part) =>
              part.type === "tool-call"
                ? (cards.get(JSON.stringify([entry.runId, part.callId])) ?? [])
                : [],
            );

            if (!text.trim() && !approvals.length) {
              return [];
            }

            return [
              {
                id: entry.id,
                runId: entry.runId,
                role: "assistant",
                text,
                ...(approvals.length && { approvals }),
              },
            ];
          }

          return [];
        }),
        receipts: receipts.map(toReceipt),
        active: running ? { id: running.id, input: running.input, text: running.text } : null,
      } satisfies ChatSnapshot;
    });

  const marker = (id: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        readonly updatedAt: number | null;
        readonly title: string | null;
        readonly titleSource: string | null;
        readonly lastMessage: number | null;
        readonly approvals: string | null;
        readonly statuses: string | null;
      }>`SELECT
        (SELECT updated_at FROM sessions WHERE id = ${id}) AS updatedAt,
        (SELECT title FROM sessions WHERE id = ${id}) AS title,
        (SELECT title_source FROM sessions WHERE id = ${id}) AS titleSource,
        (SELECT MAX(id) FROM messages WHERE session_id = ${id}) AS lastMessage,
        (SELECT group_concat(a.id || a.state) FROM approvals a JOIN web_chat_submissions w ON w.id=a.run_id WHERE w.session_id=${id}) AS approvals,
        (SELECT group_concat(status) FROM web_chat_submissions WHERE session_id = ${id}) AS statuses`;

      const running = active.get(id);

      return JSON.stringify([
        row?.updatedAt ?? null,
        row?.title ?? null,
        row?.titleSource ?? null,
        row?.lastMessage ?? null,
        row?.statuses ?? null,
        row?.approvals ?? null,
        running ? [running.id, running.text.length] : null,
      ]);
    });

  const start = (sessionId: string, id: string, text: string, resumed: boolean) =>
    Effect.gen(function* () {
      const previousMessageId = resumed
        ? ((yield* sql<{
            lastId: number;
          }>`SELECT MAX(id) AS last_id FROM messages WHERE run_id = ${id}`)[0]?.lastId ?? 0)
        : 0;

      const running: ActiveReply = { id, input: text, previousMessageId, text: "", fiber: null };
      active.set(sessionId, running);

      let waiting = false;
      const options = { runId: id, approvalRequester: { surface: "web" } };
      const stream = resumed ? agent.resume(id, options) : agent.send(sessionId, text, options);

      const execute = stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "waiting") {
              waiting = true;
            }

            if (event.type === "text-delta") {
              running.text += event.text;
            }
          }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (waiting) {
              return;
            }

            const status = Exit.isSuccess(exit)
              ? "completed"
              : Cause.hasInterrupts(exit.cause)
                ? "interrupted"
                : "failed";

            let error: string | null = null;

            if (status === "interrupted") {
              error = "Reply stopped. It will not restart automatically.";
            }

            if (status === "failed") {
              error = "The reply failed. Run poppet chat show for details.";
            }

            yield* sql`UPDATE web_chat_submissions SET status = ${status}, error = ${error} WHERE id = ${id}`;
          }).pipe(Effect.ensuring(Effect.sync(() => active.delete(sessionId)))),
        ),
        Effect.catchCause(() => Effect.void),
      );

      running.fiber = yield* execute.pipe(Effect.interruptible, Effect.forkIn(scope));
    });

  const reconcile = submissions.withPermit(
    Effect.gen(function* () {
      yield* store.expireApprovals;

      const rows = yield* sql<{
        id: string;
        sessionId: string;
        status: string;
      }>`SELECT w.id,w.session_id,r.status FROM web_chat_submissions w JOIN runs r ON w.id=r.id WHERE w.status='accepted' AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=w.id AND a.state != 'pending')`;

      for (const row of rows) {
        if (active.has(row.sessionId)) {
          continue;
        }

        if (row.status === "running") {
          const latest = yield* store.latestApproval(row.id);

          if (active.size < 16 && (latest?.state === "approved" || latest?.state === "denied")) {
            yield* start(row.sessionId, row.id, "", true);
          }
        } else if (
          row.status === "failed" ||
          row.status === "interrupted" ||
          row.status === "completed"
        ) {
          yield* sql`UPDATE web_chat_submissions SET status=${row.status},error=${row.status === "completed" ? null : "Reply ended. See the approval for details."} WHERE id=${row.id}`;
        }
      }
    }),
  );

  yield* reconcile.pipe(
    Effect.catchCause(Effect.logError),
    Effect.delay("500 millis"),
    Effect.forever,
    Effect.forkScoped,
  );

  const decide = (id: string, decision: "approved" | "denied") =>
    Effect.gen(function* () {
      const approval = yield* store.approval(id);

      if (!approval || approval.requester.surface !== "web" || !(yield* receipt(approval.runId))) {
        return yield* new WebChatError({ status: 404, message: "Approval not found." });
      }

      yield* store.decideApproval(id, {
        decision,
        adapter: "web",
        senderId: "access-key holder",
        at: yield* Clock.currentTimeMillis,
      });
      yield* store.expireApprovals;

      return { state: (yield* store.approval(id))?.state };
    });

  const submit = (input: Submission) =>
    Effect.gen(function* () {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([input.sessionId, input.text]))
        .digest("hex");

      const existing = yield* receipt(input.id);

      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return yield* new WebChatError({
            status: 409,
            message: "This submission ID already belongs to another message.",
          });
        }

        return toReceipt(existing);
      }

      if (input.sessionId && active.has(input.sessionId)) {
        return yield* new WebChatError({
          status: 409,
          message: "Wait for the current reply or stop it before sending.",
        });
      }

      if (active.size >= 16) {
        return yield* new WebChatError({
          status: 429,
          message: "Too many active conversations. Wait for a reply to finish.",
        });
      }

      const model = config.model;

      if (!input.sessionId && !model) {
        return yield* new WebChatError({
          status: 409,
          message: "Set a model in Poppet's config.json first.",
        });
      }

      const accepted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const session = input.sessionId
            ? yield* store.session(input.sessionId)
            : yield* store.createSession(config.provider, model ?? "");

          if (!session) {
            return yield* new WebChatError({ status: 404, message: "Conversation not found." });
          }

          const runs = yield* store.runs(session.id);

          if (
            runs.some(
              (run) =>
                run.status === "pending" || run.status === "running" || run.status === "waiting",
            )
          ) {
            return yield* new WebChatError({
              status: 409,
              message: "This conversation already has a reply in progress.",
            });
          }

          yield* sql`INSERT INTO web_chat_submissions (id, session_id, fingerprint, status) VALUES (${input.id}, ${session.id}, ${fingerprint}, 'accepted')`;

          return {
            id: input.id,
            sessionId: session.id,
            status: "accepted",
            error: null,
          } satisfies Receipt;
        }),
      );

      yield* start(accepted.sessionId, input.id, input.text, false);

      return accepted;
    }).pipe((effect) => submissions.withPermit(effect), Effect.uninterruptible);

  const stop = (id: string) =>
    submissions
      .withPermit(Effect.sync(() => active.get(id)?.fiber))
      .pipe(Effect.flatMap((fiber) => (fiber ? Fiber.interrupt(fiber) : Effect.void)));

  const remove = (id: string) =>
    Effect.gen(function* () {
      const busy = new WebChatError({
        status: 409,
        message: "Stop the current reply before deleting this conversation.",
      });

      if (!(yield* store.session(id))) {
        return yield* new WebChatError({ status: 404, message: "Conversation not found." });
      }

      if (active.has(id)) {
        return yield* busy;
      }

      yield* removeSessions(store.deleteSessions([id])).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) => (error.reason === "conflict" ? busy : error)),
      );
    }).pipe((effect) => submissions.withPermit(effect));

  const sessions = (source: string) =>
    sql<ChatSession>`SELECT id, title, provider, model, updated_at FROM sessions
      ${source === "all" ? sql`` : sql`WHERE origin = ${source}`}
      ORDER BY updated_at DESC, created_at, id`;

  const sessionList = (source: string) =>
    Effect.gen(function* () {
      const origins = yield* sql<{ readonly origin: string }>`SELECT DISTINCT origin FROM sessions
        WHERE origin GLOB 'gateway:*' ORDER BY origin`;

      return {
        sessions: yield* sessions(source),
        gateways: origins.map(({ origin }) => origin.slice("gateway:".length)),
      } satisfies SessionList;
    });

  return {
    decide,
    remove,
    sessions: sessions("all"),
    sessionList,
    snapshot,
    marker,
    submit,
    stop,
    receipt: (id: string) =>
      receipt(id).pipe(Effect.map((value) => (value ? toReceipt(value) : null))),
  };
});

export class WebChat extends Context.Service<WebChat, Effect.Success<typeof makeWebChat>>()(
  "poppet/WebChat",
) {}

export const WebChatLive = Layer.effect(WebChat, makeWebChat);
