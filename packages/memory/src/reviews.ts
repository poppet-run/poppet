import { randomUUID } from "node:crypto";

import { StoreDatabase } from "@poppet/store";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { MemoryError } from "#src/service";

/** A skill or fact change made by background review, recorded for notices and inspection. */
export const ReviewChange = Schema.Struct({
  kind: Schema.Literals(["skill", "fact"]),
  action: Schema.Literals(["create", "patch", "replace", "delete", "remember", "forget"]),
  name: Schema.NonEmptyString,
  revision: Schema.NullOr(Schema.Int),
  project: Schema.NullOr(Schema.NonEmptyString),
});

export type ReviewChange = typeof ReviewChange.Type;

export const ReviewState = Schema.Literals([
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "uncertain",
]);

export type ReviewState = typeof ReviewState.Type;

export const LearningReview = Schema.Struct({
  id: Schema.NonEmptyString,
  sourceRunId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  state: ReviewState,
  reason: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  changes: Schema.Array(ReviewChange),
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
  notifiedAt: Schema.NullOr(Schema.Natural),
});

export type LearningReview = typeof LearningReview.Type;

/** Durable background-review queue, one review per source run. */
export class LearningReviews extends Context.Service<
  LearningReviews,
  {
    /** Records a qualifying run; a run already queued is left unchanged and returns null. */
    readonly enqueue: (input: {
      readonly sourceRunId: string;
      readonly sessionId: string;
      readonly state: "pending" | "skipped";
      readonly reason: string | null;
    }) => Effect.Effect<LearningReview | null, MemoryError>;
    /** Creation time of the session's most recent review in any state. */
    readonly lastReviewAt: (sessionId: string) => Effect.Effect<number | null, MemoryError>;
    /** Skips stale pending reviews, then claims the oldest remaining one. */
    readonly claim: (maxAgeMs: number) => Effect.Effect<LearningReview | null, MemoryError>;
    readonly finish: (
      id: string,
      outcome: {
        readonly state: "completed" | "skipped" | "failed" | "uncertain";
        readonly reason?: string | null;
        readonly summary?: string | null;
        readonly changes?: ReadonlyArray<ReviewChange>;
      },
    ) => Effect.Effect<void, MemoryError>;
    /** Marks reviews interrupted by a crash uncertain; their writes are never replayed. */
    readonly recover: Effect.Effect<number, MemoryError>;
    /** Completed reviews with changes not yet shown in this session, oldest first. */
    readonly notices: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<LearningReview>, MemoryError>;
    readonly markNotified: (ids: ReadonlyArray<string>) => Effect.Effect<void, MemoryError>;
    readonly list: (options: {
      readonly state?: ReviewState;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<LearningReview>, MemoryError>;
  }
>()("poppet/LearningReviews") {}

const reviewSql =
  "SELECT id, source_run_id AS sourceRunId, session_id AS sessionId, state, reason, summary, changes, created_at AS createdAt, updated_at AS updatedAt, notified_at AS notifiedAt FROM learning_reviews";

const Row = Schema.Struct({
  ...LearningReview.fields,
  changes: Schema.fromJsonString(Schema.Array(ReviewChange)),
});

const failure = (cause: unknown) =>
  cause instanceof MemoryError
    ? cause
    : new MemoryError({
        reason: cause instanceof Schema.SchemaError ? "corrupt" : "storage",
        message:
          cause instanceof Schema.SchemaError
            ? "The learning review queue contains an invalid record."
            : "Poppet could not read or write its learning review queue.",
      });

const truncate = (text: string | null | undefined, bytes: number) => {
  if (text === null || text === undefined) return null;
  let result = text;

  while (Buffer.byteLength(result) > bytes) result = result.slice(0, -1);

  return result;
};

const sync = <A>(run: () => A) => Effect.try({ try: run, catch: failure });

const decode = (rows: ReadonlyArray<unknown>) => Schema.decodeUnknownSync(Schema.Array(Row))(rows);

export const LearningReviewsLive = Layer.effect(
  LearningReviews,
  Effect.gen(function* () {
    const { database } = yield* StoreDatabase;
    const now = DateTime.nowAsDate.pipe(Effect.map((date) => date.getTime()));

    const byId = (id: string) => {
      using statement = database.prepare(`${reviewSql} WHERE id = ?`);

      return decode([statement.get(id)].filter((row) => row !== null))[0] ?? null;
    };

    return {
      enqueue: (input) =>
        Effect.flatMap(now, (at) =>
          sync(() => {
            const id = randomUUID();

            using statement = database.prepare(
              "INSERT OR IGNORE INTO learning_reviews (id, source_run_id, session_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            );

            if (
              statement.run(
                id,
                input.sourceRunId,
                input.sessionId,
                input.state,
                input.reason,
                at,
                at,
              ).changes === 0
            )
              return null;

            return byId(id);
          }),
        ),
      lastReviewAt: (sessionId) =>
        sync(() => {
          using statement = database.prepare(
            "SELECT MAX(created_at) AS at FROM learning_reviews WHERE session_id = ?",
          );

          return Schema.decodeUnknownSync(Schema.Struct({ at: Schema.NullOr(Schema.Natural) }))(
            statement.get(sessionId),
          ).at;
        }),
      claim: (maxAgeMs) =>
        Effect.flatMap(now, (at) =>
          sync(() =>
            database
              .transaction(() => {
                using stale = database.prepare(
                  "UPDATE learning_reviews SET state = 'skipped', reason = 'stale', updated_at = ? WHERE state = 'pending' AND created_at < ?",
                );

                stale.run(at, at - maxAgeMs);

                using next = database.prepare(
                  `${reviewSql} WHERE state = 'pending' ORDER BY created_at, id LIMIT 1`,
                );

                const review = decode([next.get()].filter((row) => row !== null))[0];

                if (review === undefined) return null;

                using claim = database.prepare(
                  "UPDATE learning_reviews SET state = 'running', updated_at = ? WHERE id = ?",
                );

                claim.run(Math.max(at, review.createdAt), review.id);

                return byId(review.id);
              })
              .immediate(),
          ),
        ),
      finish: (id, outcome) =>
        Effect.flatMap(now, (at) =>
          sync(() => {
            using statement = database.prepare(
              "UPDATE learning_reviews SET state = ?, reason = ?, summary = ?, changes = ?, updated_at = MAX(created_at, ?) WHERE id = ? AND state = 'running'",
            );

            if (
              statement.run(
                outcome.state,
                truncate(outcome.reason, 512),
                truncate(outcome.summary, 4096),
                JSON.stringify(outcome.changes ?? []),
                at,
                id,
              ).changes === 0
            )
              throw new MemoryError({
                reason: "conflict",
                message: "The learning review is not running.",
              });
          }),
        ),
      recover: Effect.flatMap(now, (at) =>
        sync(() => {
          using statement = database.prepare(
            "UPDATE learning_reviews SET state = 'uncertain', reason = 'interrupted', updated_at = MAX(created_at, ?) WHERE state = 'running'",
          );

          return statement.run(at).changes;
        }),
      ),
      notices: (sessionId) =>
        sync(() => {
          using statement = database.prepare(
            `${reviewSql} WHERE session_id = ? AND state = 'completed' AND notified_at IS NULL AND changes != '[]' ORDER BY created_at, id`,
          );

          return decode(statement.all(sessionId));
        }),
      markNotified: (ids) =>
        Effect.flatMap(now, (at) =>
          sync(() =>
            database
              .transaction(() => {
                using statement = database.prepare(
                  "UPDATE learning_reviews SET notified_at = MAX(created_at, ?) WHERE id = ? AND notified_at IS NULL",
                );

                for (const id of ids) statement.run(at, id);
              })
              .immediate(),
          ),
        ),
      list: ({ state, limit }) =>
        sync(() => {
          using statement = database.prepare(
            state === undefined
              ? `${reviewSql} ORDER BY created_at DESC, id LIMIT ?`
              : `${reviewSql} WHERE state = ? ORDER BY created_at DESC, id LIMIT ?`,
          );

          return decode(state === undefined ? statement.all(limit) : statement.all(state, limit));
        }),
    } satisfies LearningReviews["Service"];
  }),
);
