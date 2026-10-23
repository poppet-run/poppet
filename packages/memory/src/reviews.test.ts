import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Effect, Layer } from "effect";

import { LearningReviews, LearningReviewsLive } from "#src/reviews";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-reviews-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "test-provider",
    model: null,
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const layer = LearningReviewsLive.pipe(Layer.provideMerge(store));

  return {
    run: <A, E>(program: Effect.Effect<A, E, LearningReviews | Store | StoreDatabase>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const runs = (count: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const session = yield* store.createSession("test-provider", "test-model");
    const ids: string[] = [];

    for (let index = 0; index < count; index++) {
      const run = yield* store.queueRun(session.id, [{ role: "user", text: `Hello ${index}` }]);
      yield* store.startRun(run.id);
      yield* store.finishRun(run.id, { status: "failed", reason: "test" });
      ids.push(run.id);
    }

    return { sessionId: session.id, ids };
  });

describe.concurrent("LearningReviews", () => {
  test("when runs are queued, deduplicates reviews, claims oldest first, and records outcomes", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const reviews = yield* LearningReviews;
          const { sessionId, ids } = yield* runs(3);

          const first = yield* reviews.enqueue({
            sourceRunId: ids[0]!,
            sessionId,
            state: "pending",
            reason: null,
          });

          expect(first).toMatchObject({ state: "pending", changes: [], notifiedAt: null });
          expect(
            yield* reviews.enqueue({
              sourceRunId: ids[0]!,
              sessionId,
              state: "pending",
              reason: null,
            }),
          ).toBeNull();
          yield* reviews.enqueue({
            sourceRunId: ids[1]!,
            sessionId,
            state: "skipped",
            reason: "untrusted-content",
          });
          yield* reviews.enqueue({
            sourceRunId: ids[2]!,
            sessionId,
            state: "pending",
            reason: null,
          });
          expect(yield* reviews.lastReviewAt(sessionId)).toBeNumber();
          expect(yield* reviews.lastReviewAt("missing")).toBeNull();

          const claimed = yield* reviews.claim(3_600_000);
          expect(claimed).toMatchObject({ id: first!.id, state: "running" });

          const change = {
            kind: "skill" as const,
            action: "create" as const,
            name: "triage",
            revision: 1,
            project: null,
          };

          yield* reviews.finish(claimed!.id, {
            state: "completed",
            summary: "Saved triage.",
            changes: [change],
          });
          // Only a running review can finish.
          expect(
            yield* reviews.finish(claimed!.id, { state: "failed" }).pipe(Effect.flip),
          ).toMatchObject({ reason: "conflict" });

          const second = yield* reviews.claim(3_600_000);
          expect(second?.sourceRunId).toBe(ids[2]);
          expect(yield* reviews.claim(3_600_000)).toBeNull();
          expect(yield* reviews.recover).toBe(1);

          const listed = yield* reviews.list({ limit: 10 });
          expect(listed.map((review) => [review.sourceRunId, review.state])).toEqual(
            expect.arrayContaining([
              [ids[0], "completed"],
              [ids[1], "skipped"],
              [ids[2], "uncertain"],
            ]),
          );
          expect(yield* reviews.list({ state: "completed", limit: 10 })).toMatchObject([
            { summary: "Saved triage.", changes: [change] },
          ]);

          const notices = yield* reviews.notices(sessionId);
          expect(notices.map((review) => review.id)).toEqual([first!.id]);
          yield* reviews.markNotified(notices.map((review) => review.id));
          expect(yield* reviews.notices(sessionId)).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when pending reviews exceed the maximum age, skips them", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const reviews = yield* LearningReviews;
          const { sessionId, ids } = yield* runs(1);
          yield* reviews.enqueue({
            sourceRunId: ids[0]!,
            sessionId,
            state: "pending",
            reason: null,
          });
          yield* Effect.sleep("5 millis");
          expect(yield* reviews.claim(1)).toBeNull();
          expect(yield* reviews.list({ limit: 1 })).toMatchObject([
            { state: "skipped", reason: "stale" },
          ]);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
