import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cause, Context, Effect, Exit, Fiber, Option, Schema, Scope } from "effect";

import { TaskCommand, TaskError } from "#src/task-schema";

export const taskSocketPath = (directory: string) => join(directory, "store", "tasks.sock");

// The host handles interactive commands; this listener only owns their protected transport.
export class WorkerRequests extends Context.Service<
  WorkerRequests,
  {
    readonly handle: (
      request: Request,
      body: Schema.Json,
    ) => Effect.Effect<Response, never, Scope.Scope>;
  }
>()("poppet/WorkerRequests") {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

// Bun uses FailedToOpenSocket for a refused Unix-socket connection.
const UnavailableSocket = Schema.Struct({
  code: Schema.Literals(["ECONNREFUSED", "FailedToOpenSocket"]),
});

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

// Only absence or a refused connection permits fallback, never a lost response.
export const requestWorker = async (
  path: string,
  route: string,
  command: Schema.Json,
  signal: AbortSignal,
) => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (Schema.is(MissingFile)(cause)) return null;
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
    throw new TaskError({ message: "The task socket or its directory is not protected." });

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
    throw new TaskError({
      message:
        "The worker request exceeds the 2 MiB size limit. Shorten it; the command was not retried.",
    });

  return response;
};

export const remoteTaskCommand = (path: string, command: TaskCommand) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await requestWorker(
        path,
        "/tasks",
        command,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );

      if (response === null) return null;

      const reply = Schema.decodeUnknownSync(Reply)(await response.json());

      if (!reply.ok) throw new TaskError({ message: reply.message });

      return { value: reply.value };
    },
    catch: (cause) =>
      cause instanceof TaskError
        ? cause
        : new TaskError({
            message:
              "Could not reach the task worker. Check it is running. The command was not retried.",
          }),
  });

export const serveTasks = <E extends { readonly message: string }>(
  path: string,
  handle: (command: TaskCommand) => Effect.Effect<unknown, E>,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const extra = yield* Effect.serviceOption(WorkerRequests);

      return yield* Effect.tryPromise({
        try: async () => {
          const info = await lstat(path).catch((cause: unknown) => {
            if (Schema.is(MissingFile)(cause)) return null;
            throw cause;
          });

          // The caller already owns SQLite. A leftover socket can belong only to its previous owner.
          if (info) {
            if (!info.isSocket())
              throw new TaskError({ message: "Refusing to replace a non-socket task endpoint." });
            await unlink(path);
          }

          const server = Bun.serve({
            unix: path,
            // Chat budgets allow 1 MiB of serialized context. Leave room for command metadata.
            maxRequestBodySize: 2 * 1024 * 1024,
            fetch(request, listener) {
              listener.timeout(request, 10);

              const reply = Effect.gen(function* () {
                const route = new URL(request.url).pathname;

                if (request.method !== "POST" || (route !== "/tasks" && Option.isNone(extra)))
                  return new Response("Not found", { status: 404 });

                const body = yield* Effect.tryPromise({
                  try: async () => Schema.decodeUnknownSync(Schema.Json)(await request.json()),
                  catch: () => new TaskError({ message: "Invalid request body." }),
                }).pipe(Effect.timeout("10 seconds"), Effect.option);

                if (Option.isNone(body))
                  return Response.json(
                    { ok: false, message: "Invalid or timed-out request body." },
                    { status: 400, headers: { connection: "close" } },
                  );

                if (route !== "/tasks" && Option.isSome(extra)) {
                  const response = yield* extra.value.handle(request, body.value);

                  // A decoded chat can wait quietly for the shared runner.
                  if (response.headers.get("content-type") === "application/x-ndjson")
                    listener.timeout(request, 0);

                  return response;
                }

                const command = Schema.decodeUnknownOption(TaskCommand)(body.value);

                if (Option.isNone(command))
                  return Response.json(
                    { ok: false, message: "Invalid task command." },
                    { status: 400 },
                  );

                const exit = yield* Effect.exit(handle(command.value));

                if (Exit.isSuccess(exit)) return Response.json({ ok: true, value: exit.value });
                const failure = Cause.findErrorOption(exit.cause);

                return Response.json(
                  {
                    ok: false,
                    message: Option.isSome(failure)
                      ? failure.value.message
                      : "The task command failed.",
                  },
                  { status: 400 },
                );
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
          });

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
          cause instanceof TaskError
            ? cause
            : new TaskError({ message: "Could not open the local task socket." }),
      });
    }),
    (server) =>
      Effect.promise(async () => {
        // Request scopes have already interrupted their streams. Drain responses before releasing SQLite.
        await server.stop();
        await unlink(path).catch((cause: unknown) => {
          if (!Schema.is(MissingFile)(cause)) throw cause;
        });
      }),
  );
