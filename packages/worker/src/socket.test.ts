import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Console, Deferred, Effect, Exit, Fiber, Scope } from "effect";

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

  test("when starting on a private socket path, protects the parent directory, refuses to clobber a live listener, and rejects unsafe directories on request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-socket-"));
    const socketDir = join(directory, "store");
    const socketPath = join(socketDir, "tasks.sock");

    try {
      const scope = await Effect.runPromise(Scope.make());

      try {
        await Effect.runPromise(
          serveWorker(socketPath, () =>
            Effect.succeed(Response.json({ ok: true, value: "hi" })),
          ).pipe(Scope.provide(scope)),
        );

        expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
        expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

        const response = await requestWorker(
          socketPath,
          "/ping",
          {},
          new AbortController().signal,
        );

        expect(await response?.json()).toEqual({ ok: true, value: "hi" });

        await expect(
          Effect.runPromise(
            Effect.scoped(serveWorker(socketPath, () => Effect.succeed(new Response("ok")))),
          ),
        ).rejects.toMatchObject({ message: expect.stringContaining("already listening") });

        await chmod(socketDir, 0o755);
        await expect(
          requestWorker(socketPath, "/ping", {}, new AbortController().signal),
        ).rejects.toMatchObject({ message: expect.stringContaining("not protected") });
        await chmod(socketDir, 0o700);
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
