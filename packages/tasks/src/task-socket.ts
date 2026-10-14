import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Cause, Effect, Exit, Option, Schema } from "effect";

import { TaskCommand, TaskError } from "#src/task-schema";

export const taskSocketPath = (directory: string) => join(directory, "store", "tasks.sock");

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

// Bun uses FailedToOpenSocket for a refused Unix-socket connection.
const UnavailableSocket = Schema.Struct({
  code: Schema.Literals(["ECONNREFUSED", "FailedToOpenSocket"]),
});

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

// Only a refused connection permits fallback; a lost response does not mean a mutation failed.
export const remoteTaskCommand = (path: string, command: TaskCommand) =>
  Effect.tryPromise({
    try: async () => {
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

      const response = await fetch("http://localhost/tasks", {
        unix: path,
        method: "POST",
        body: JSON.stringify(command),
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      }).catch((cause: unknown) => {
        if (Schema.is(UnavailableSocket)(cause)) return null;
        throw cause;
      });

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
    Effect.tryPromise({
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

        const requests = new Set<Promise<Response>>();

        const server = Bun.serve({
          unix: path,
          maxRequestBodySize: 131_072,
          fetch(request) {
            const reply = (async () => {
              if (request.method !== "POST" || new URL(request.url).pathname !== "/tasks")
                return new Response("Not found", { status: 404 });

              const command = await request
                .json()
                .then((body) => Schema.decodeUnknownSync(TaskCommand)(body))
                .catch(() => null);

              if (command === null)
                return Response.json(
                  { ok: false, message: "Invalid task command." },
                  { status: 400 },
                );
              const exit = await Effect.runPromiseExit(handle(command));

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
            })();

            requests.add(reply);
            void reply.finally(() => requests.delete(reply));

            return reply;
          },
        });

        try {
          await chmod(path, 0o600);
        } catch (cause) {
          await server.stop(true);
          await unlink(path);
          throw cause;
        }

        return { server, requests };
      },
      catch: (cause) =>
        cause instanceof TaskError
          ? cause
          : new TaskError({ message: "Could not open the local task socket." }),
    }),
    ({ server, requests }) =>
      Effect.promise(async () => {
        await server.stop(true);
        // Finish commands before the enclosing scope releases SQLite.
        await Promise.allSettled(requests);
        await unlink(path).catch((cause: unknown) => {
          if (!Schema.is(MissingFile)(cause)) throw cause;
        });
      }),
  );
