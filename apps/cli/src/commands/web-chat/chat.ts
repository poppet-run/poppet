import { createHash } from "node:crypto";

import { Agent } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Store, decodeRow, decodeRows, migrate, packageSchema } from "@poppet/store";
import type { ChatSession, ChatSnapshot, Receipt, Submission } from "@poppet/web/protocol";
import {
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

export class WebChatError extends Data.TaggedError("WebChatError")<{
  readonly status: number;
  readonly message: string;
}> {}

export const SubmissionBody = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  sessionId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))),
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32768),
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

const webSchema = packageSchema("web_chat_migrations", {
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
});

interface ActiveReply {
  id: string;
  input: string;
  text: string;
  fiber: Fiber.Fiber<void> | null;
}

const summary = (session: ChatSession): ChatSession => ({
  id: session.id,
  title: session.title,
  provider: session.provider,
  model: session.model,
  updatedAt: session.updatedAt,
});

/** Runs belong to the worker scope, never to an HTTP connection. */
const makeWebChat = Effect.gen(function* () {
  const store = yield* Store;
  const agent = yield* Agent;
  const config = yield* AppConfig;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const submissions = yield* Semaphore.make(1);
  const active = new Map<string, ActiveReply>();

  yield* migrate(webSchema);
  yield* sql`UPDATE web_chat_submissions SET
    status = COALESCE((SELECT status FROM runs WHERE runs.id = web_chat_submissions.id AND status IN ('completed', 'failed', 'interrupted')), 'interrupted'),
    error = CASE WHEN EXISTS (SELECT 1 FROM runs WHERE runs.id = web_chat_submissions.id AND status = 'completed') THEN NULL
      ELSE 'Worker restarted. Inspect the conversation before sending again.' END
    WHERE status = 'accepted'`;

  const receipt = (id: string) =>
    sql`SELECT * FROM web_chat_submissions WHERE id = ${id}`.pipe(decodeRow(ReceiptRow));

  const snapshot = (id: string) =>
    Effect.gen(function* () {
      const session = yield* store.session(id);

      if (!session)
        return yield* new WebChatError({ status: 404, message: "Conversation not found." });
      const messages = yield* store.messages(id);

      const receipts =
        yield* sql`SELECT * FROM web_chat_submissions WHERE session_id = ${id} ORDER BY rowid`.pipe(
          decodeRows(ReceiptRow),
        );

      const running = active.get(id);

      return {
        session: summary(session),
        messages: messages.flatMap<ChatSnapshot["messages"][number]>((entry) => {
          if (entry.message.role === "user")
            return [
              { id: entry.id, runId: entry.runId, role: "user" as const, text: entry.message.text },
            ];

          if (entry.message.role === "assistant") {
            // Tool requests also create assistant messages. Show the live reply until
            // the run finishes, then show its saved messages.
            if (entry.runId === running?.id) return [];

            const text = entry.message.output
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");

            if (!text.trim()) return [];

            return [{ id: entry.id, runId: entry.runId, role: "assistant", text }];
          }

          return [];
        }),
        receipts: receipts.map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          status: entry.status,
          error: entry.error,
        })),
        active: running ? { id: running.id, input: running.input, text: running.text } : null,
      } satisfies ChatSnapshot;
    });

  /** Changes whenever the snapshot can change, without loading the conversation. */
  const marker = (id: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ readonly marker: string | null }>`SELECT
        (SELECT updated_at FROM sessions WHERE id = ${id}) || ':' ||
        COALESCE((SELECT MAX(id) FROM messages WHERE session_id = ${id}), '') || ':' ||
        COALESCE((SELECT group_concat(status) FROM web_chat_submissions WHERE session_id = ${id}), '')
        AS marker`;

      const running = active.get(id);

      return `${row?.marker ?? ""}:${running ? `${running.id}:${running.text.length}` : ""}`;
    });

  const submit = (input: Submission) =>
    Effect.gen(function* () {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([input.sessionId, input.text]))
        .digest("hex");

      const existing = yield* receipt(input.id);

      if (existing) {
        if (existing.fingerprint !== fingerprint)
          return yield* new WebChatError({
            status: 409,
            message: "This submission ID already belongs to another message.",
          });

        return {
          id: existing.id,
          sessionId: existing.sessionId,
          status: existing.status,
          error: existing.error,
        } satisfies Receipt;
      }

      if (input.sessionId && active.has(input.sessionId))
        return yield* new WebChatError({
          status: 409,
          message: "Wait for the current reply or stop it before sending.",
        });

      if (active.size >= 16)
        return yield* new WebChatError({
          status: 429,
          message: "Too many active conversations. Wait for a reply to finish.",
        });

      if (!input.sessionId && !config.model)
        return yield* new WebChatError({
          status: 409,
          message: "Set a model in Poppet's config.json first.",
        });

      const accepted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const session = input.sessionId
            ? yield* store.session(input.sessionId)
            : yield* store.createSession(config.provider, config.model!);

          if (!session)
            return yield* new WebChatError({ status: 404, message: "Conversation not found." });
          const runs = yield* store.runs(session.id);

          if (runs.some((run) => run.status === "pending" || run.status === "running"))
            return yield* new WebChatError({
              status: 409,
              message: "This conversation already has a reply in progress.",
            });
          yield* sql`INSERT INTO web_chat_submissions (id, session_id, fingerprint, status) VALUES (${input.id}, ${session.id}, ${fingerprint}, 'accepted')`;

          return {
            id: input.id,
            sessionId: session.id,
            status: "accepted",
            error: null,
          } satisfies Receipt;
        }),
      );

      const running: ActiveReply = { id: input.id, input: input.text, text: "", fiber: null };
      active.set(accepted.sessionId, running);

      const execute = agent.send(accepted.sessionId, input.text, { runId: input.id }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "text-delta") running.text += event.text;
          }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const status = Exit.isSuccess(exit)
              ? "completed"
              : Cause.hasInterrupts(exit.cause)
                ? "interrupted"
                : "failed";

            let error: string | null = null;

            if (status === "interrupted")
              error = "Reply stopped. It will not restart automatically.";

            if (status === "failed") error = "The reply failed. Run poppet chat show for details.";
            yield* sql`UPDATE web_chat_submissions SET status = ${status}, error = ${error} WHERE id = ${input.id}`;
          }).pipe(Effect.ensuring(Effect.sync(() => active.delete(accepted.sessionId)))),
        ),
        Effect.catchCause(() => Effect.void),
      );

      running.fiber = yield* execute.pipe(Effect.interruptible, Effect.forkIn(scope));

      return accepted;
    }).pipe(submissions.withPermit, Effect.uninterruptible);

  const stop = (id: string) =>
    Effect.gen(function* () {
      const running = active.get(id);

      if (running?.fiber) yield* Fiber.interrupt(running.fiber);
      // The permit waits for a submission that is still assigning its fiber.
    }).pipe(submissions.withPermit);

  return {
    sessions: store.sessions.pipe(
      Effect.map((sessions) => sessions.map(summary).toSorted((a, b) => b.updatedAt - a.updatedAt)),
    ),
    snapshot,
    marker,
    submit,
    stop,
    receipt: (id: string) =>
      receipt(id).pipe(
        Effect.map((value) =>
          value
            ? { id: value.id, sessionId: value.sessionId, status: value.status, error: value.error }
            : null,
        ),
      ),
  };
});

export class WebChat extends Context.Service<WebChat, Effect.Success<typeof makeWebChat>>()(
  "poppet/WebChat",
) {}

export const WebChatLive = Layer.effect(WebChat, makeWebChat);
