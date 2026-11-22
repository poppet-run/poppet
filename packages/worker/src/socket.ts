import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

<<<<<<< HEAD
import { isMissingFile } from "@poppet/io";
import { Cause, Context, Data, Effect, Exit, Option, Schema, Scope } from "effect";
||||||| parent of 81bd2fc (Harden worker socket directory checks and live socket ownership)
import { isMissingFile } from "@poppet/io";
import { Cause, Context, Data, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
=======
import { ensurePrivateDirectory, isMissingFile } from "@poppet/io";
import { Cause, Context, Data, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";
>>>>>>> 81bd2fc (Harden worker socket directory checks and live socket ownership)

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
    directory.uid !== process.getuid?.() ||
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

<<<<<<< HEAD
const scopedBody = (
  body: ReadableStream<Uint8Array>,
  finish: (exit: Exit.Exit<unknown, unknown>) => Promise<void>,
) => {
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          controller.close();
          await finish(Exit.void);
        } else controller.enqueue(chunk.value);
      } catch (cause) {
        controller.error(cause);
        await finish(Exit.die(cause));
      }
    },
    async cancel(reason) {
      await Promise.all([reader.cancel(reason), finish(Exit.interrupt())]);
    },
  });
};

const isSocketLive = async (path: string) => {
  try {
    const response = await fetch("http://localhost/", {
      unix: path,
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });

    await response.body?.cancel().catch(() => {});

    return true;
  } catch (cause) {
    return !Schema.is(UnavailableSocket)(cause);
  }
};

export const serveWorker = (path: string, handle: WorkerRequests["Service"]["handle"]) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const services = yield* Effect.context<Scope.Scope>();
      const run = Effect.runPromiseWith(services);
      const runExit = Effect.runPromiseExitWith(services);

      return yield* Effect.tryPromise({
        try: async () => {
          await ensurePrivateDirectory(dirname(path)).catch(() => {
            throw new WorkerRequestError({
              message: "The worker socket directory is not protected.",
            });
          });

          const info = await lstat(path).catch((cause: unknown) => {
            if (isMissingFile(cause)) return null;
            throw cause;
          });

          if (info) {
            if (!info.isSocket())
              throw new WorkerRequestError({
                message: "Refusing to replace a non-socket worker endpoint.",
              });

            if (await isSocketLive(path))
              throw new WorkerRequestError({
                message: "Another worker is already listening on this socket.",
              });

            await unlink(path);
          }

          const options: Bun.Serve.Options<undefined> = {
            unix: path,
            maxRequestBodySize: 32 * 1024 * 1024,
            async fetch(request, listener) {
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

              const owned = await run(Scope.fork(scope));

              const shutdown = await run(
                Effect.provideService(Effect.abortSignal, Scope.Scope, owned),
              );

              const finish = (exit: Exit.Exit<unknown, unknown>) => run(Scope.close(owned, exit));

              const abort = () => {
                void finish(Exit.interrupt()).catch(() => {});
              };

              const exit = await runExit(Effect.provideService(reply, Scope.Scope, owned), {
                signal: AbortSignal.any([request.signal, shutdown]),
              });

              if (Exit.isFailure(exit)) {
                await finish(exit);

                return Response.json(
                  { ok: false, message: "The worker stopped before completing the request." },
                  { status: 503, headers: { connection: "close" } },
                );
              }

              const response = exit.value;

              if (
                response.body === null ||
                response.headers.get("content-type") !== "application/x-ndjson"
              ) {
                await finish(exit);

                return response;
              }

              if (request.signal.aborted) abort();
              else request.signal.addEventListener("abort", abort, { once: true });

              return new Response(
                scopedBody(response.body, (outcome) => {
                  request.signal.removeEventListener("abort", abort);

                  return finish(outcome);
                }),
                response,
              );
            },
          };

          Object.assign(options, { idleTimeout: 0 });
          const server = Bun.serve(options);
          let bound: { readonly dev: number; readonly ino: number };

          try {
            await chmod(path, 0o600);
            const stat = await lstat(path);
            bound = { dev: stat.dev, ino: stat.ino };
          } catch (cause) {
            await server.stop(true);
            await unlink(path).catch(() => {});
            throw cause;
          }

          return { server, bound };
        },
        catch: (cause) =>
          cause instanceof WorkerRequestError
            ? cause
            : new WorkerRequestError({ message: "Could not open the local worker socket." }),
      });
    }),
    ({ server, bound }) =>
      Effect.promise(async () => {
        await server.stop(true);

        const current = await lstat(path).catch((cause: unknown) => {
          if (isMissingFile(cause)) return null;
          throw cause;
        });

        if (current !== null && current.dev === bound.dev && current.ino === bound.ino)
          await unlink(path).catch((cause: unknown) => {
            if (!isMissingFile(cause)) throw cause;
          });
      }),
  );
