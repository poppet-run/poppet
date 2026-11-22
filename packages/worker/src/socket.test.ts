import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Console, Deferred, Effect, Fiber } from "effect";

import { requestWorker, serveWorker } from "#src/socket";

describe("serveWorker", () => {
  test("when the client aborts a running request, releases its resources while the daemon stays up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-abort-"));
    const path = join(directory, "worker.sock");

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const closed = yield* Deferred.make<void>();

            yield* serveWorker(path, (request) => {
              if (new URL(request.url).pathname === "/next")
                return Effect.succeed(Response.json({ ok: true }));

              return Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                yield* Deferred.succeed(entered, undefined);

                return yield* Effect.never;
              });
            });

            const request = yield* Effect.tryPromise((signal) =>
              requestWorker(path, "/slow", {}, signal),
            ).pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            yield* Fiber.interrupt(request);
            yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"));

            const next = yield* Effect.tryPromise((signal) =>
              requestWorker(path, "/next", {}, signal),
            );

            expect(next?.status).toBe(200);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a request finishes, runs its finalizers before daemon shutdown and preserves the console", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-request-"));
    const path = join(directory, "worker.sock");
    const logs: string[] = [];

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const closed = yield* Deferred.make<void>();
            yield* serveWorker(path, () =>
              Effect.gen(function* () {
                yield* Console.log("request");
                yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));

                return Response.json({ ok: true });
              }),
            );

            const response = yield* Effect.tryPromise((signal) =>
              requestWorker(path, "/test", {}, signal),
            );

            expect(response?.status).toBe(200);
            expect(yield* Deferred.isDone(closed)).toBe(true);
            expect(logs).toEqual(["request"]);
          }),
        ).pipe(
          Effect.provideService(Console.Console, {
            ...console,
            log: (entry) => logs.push(String(entry)),
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
