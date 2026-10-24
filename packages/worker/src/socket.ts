import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isMissingFile } from "@poppet/io";
import { Context, Data, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";

/** A rejected local request or a failure to use the protected worker endpoint. */
export class WorkerRequestError extends Data.TaggedError("WorkerRequestError")<{
  readonly message: string;
}> {}

// All worker clients share this endpoint for the single store owner.
export const workerSocketPath = (directory: string) => join(directory, "store", "tasks.sock");

/** Host routing for decoded worker requests, using the listener's resource scope. */
export class WorkerRequests extends Context.Service<
  WorkerRequests,
  {
    readonly handle: (
      request: Request,
      body: Schema.Json,
    ) => Effect.Effect<Response, never, Scope.Scope>;
  }
>()("poppet/WorkerRequests") {}

// Bun uses FailedToOpenSocket for a refused Unix-socket connection.
const UnavailableSocket = Schema.Struct({
  code: Schema.Literals(["ECONNREFUSED", "FailedToOpenSocket"]),
});

/** Returns null only when no worker is reachable; a lost response must not trigger local replay. */
export const requestWorker = async (
  path: string,
  route: string,
  command: Schema.Json,
  signal: AbortSignal,
) => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

  if (info === null) return null;
  const directory = await lstat(dirname(path));

  if (
    !info.isSocket() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0
  )
    throw new WorkerRequestError({
      message: "The worker socket or its directory is not protected.",
    });

  const response = await fetch(`http://localhost${route}`, {
    unix: path,
    method: "POST",
    body: JSON.stringify(command),
    headers: { "content-type": "application/json" },
    signal,
  }).catch((cause: unknown) => {
    if (Schema.is(UnavailableSocket)(cause)) return null;
    throw cause;
  });

  if (response?.status === 413)
    throw new WorkerRequestError({
      message:
        "The worker request exceeds the 2 MiB size limit. Shorten it; the command was not retried.",
    });

  return response;
};

const decodeRequestBody = (request: Request) =>
  Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(Schema.Json)(await request.json()),
    catch: () => new WorkerRequestError({ message: "Invalid request body." }),
  }).pipe(Effect.timeout("10 seconds"), Effect.option);

/** Opens a protected Unix socket in scope; the caller must already own the store. */
export const serveWorker = (path: string, handle: WorkerRequests["Service"]["handle"]) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;

      return yield* Effect.tryPromise({
        try: async () => {
          const info = await lstat(path).catch((cause: unknown) => {
            if (isMissingFile(cause)) return null;
            throw cause;
          });

          // The caller already owns SQLite. A leftover socket can belong only to its previous owner.
          if (info) {
            if (!info.isSocket())
              throw new WorkerRequestError({
                message: "Refusing to replace a non-socket worker endpoint.",
              });
            await unlink(path);
          }

          const options: Bun.Serve.Options<undefined> = {
            unix: path,
            // Chat budgets allow 1 MiB of serialized context. Leave room for command metadata.
            maxRequestBodySize: 2 * 1024 * 1024,
            fetch(request, listener) {
              listener.timeout(request, 10);

              const reply = Effect.gen(function* () {
                if (request.method !== "POST") return new Response("Not found", { status: 404 });

                const body = yield* decodeRequestBody(request);

                if (Option.isNone(body))
                  return Response.json(
                    { ok: false, message: "Invalid or timed-out request body." },
                    { status: 400, headers: { connection: "close" } },
                  );

                const response = yield* handle(request, body.value);

                // A decoded chat can wait quietly for the shared runner.
                if (response.headers.get("content-type") === "application/x-ndjson")
                  listener.timeout(request, 0);

                return response;
              });

              // Own decoding as well as execution, so shutdown can interrupt an unfinished upload.
              return Effect.runPromise(
                reply.pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.forkIn(scope),
                  Effect.flatMap(Fiber.await),
                ),
              ).then((exit) =>
                Exit.isSuccess(exit)
                  ? exit.value
                  : Response.json(
                      { ok: false, message: "The worker stopped before completing the request." },
                      { status: 503, headers: { connection: "close" } },
                    ),
              );
            },
          };

          // Bun honors this on Unix sockets despite its types; per-request timeout is inert (#43816).
          Object.assign(options, { idleTimeout: 0 });
          const server = Bun.serve(options);

          try {
            await chmod(path, 0o600);
          } catch (cause) {
            await server.stop(true);
            await unlink(path);
            throw cause;
          }

          return server;
        },
        catch: (cause) =>
          cause instanceof WorkerRequestError
            ? cause
            : new WorkerRequestError({ message: "Could not open the local worker socket." }),
      });
    }),
    (server) =>
      Effect.promise(async () => {
        // Request scopes have already interrupted their streams. Drain responses before releasing SQLite.
        await server.stop();
        await unlink(path).catch((cause: unknown) => {
          if (!isMissingFile(cause)) throw cause;
        });
      }),
  );
