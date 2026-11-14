import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isMissingFile } from "@poppet/io";
import { Cause, Context, Data, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";

export class WorkerRequestError extends Data.TaggedError("WorkerRequestError")<{
  readonly message: string;
}> {}

export const workerSocketPath = (directory: string) => join(directory, "store", "tasks.sock");

export class WorkerRequests extends Context.Service<
  WorkerRequests,
  {
    readonly handle: (
      request: Request,
      body: Schema.Json,
    ) => Effect.Effect<Response, never, Scope.Scope>;
  }
>()("poppet/WorkerRequests") {}

const UnavailableSocket = Schema.Struct({
  code: Schema.Literals(["ECONNREFUSED", "FailedToOpenSocket"]),
});

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
        "The worker request exceeds the 32 MiB size limit. Shorten it; the command was not retried.",
    });

  return response;
};

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

export const requestWorkerReply = (
  path: string,
  route: string,
  command: Schema.Json,
  lost: string,
  timeout?: number,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await requestWorker(
        path,
        route,
        command,
        timeout === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      );

      if (response === null) return null;

      if (response.status === 404)
        throw new WorkerRequestError({
          message:
            "The worker rejected this command. Restart the worker to load the current protocol. The command was not retried.",
        });
      const reply = Schema.decodeUnknownSync(Reply)(await response.json());

      if (!reply.ok) throw new WorkerRequestError({ message: reply.message });

      return { value: reply.value };
    },
    catch: (cause) =>
      cause instanceof WorkerRequestError ? cause : new WorkerRequestError({ message: lost }),
  });

export const workerReply = <R>(
  operation: Effect.Effect<unknown, { readonly message: string }, R>,
  failed: string,
) =>
  Effect.exit(operation).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? Response.json({ ok: true, value: exit.value })
        : Response.json(
            {
              ok: false,
              message: Option.getOrNull(Cause.findErrorOption(exit.cause))?.message ?? failed,
            },
            { status: 400 },
          ),
    ),
  );

const decodeRequestBody = (request: Request) =>
  Effect.tryPromise({
    try: async () => Schema.decodeUnknownSync(Schema.Json)(await request.json()),
    catch: () => new WorkerRequestError({ message: "Invalid request body." }),
  }).pipe(Effect.timeout("10 seconds"), Effect.option);

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

          if (info) {
            if (!info.isSocket())
              throw new WorkerRequestError({
                message: "Refusing to replace a non-socket worker endpoint.",
              });
            await unlink(path);
          }

          const options: Bun.Serve.Options<undefined> = {
            unix: path,
            maxRequestBodySize: 32 * 1024 * 1024,
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

                if (response.headers.get("content-type") === "application/x-ndjson")
                  listener.timeout(request, 0);

                return response;
              });

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
        await server.stop();
        await unlink(path).catch((cause: unknown) => {
          if (!isMissingFile(cause)) throw cause;
        });
      }),
  );
