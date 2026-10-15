import { requestWorker, WorkerRequestError } from "@poppet/worker";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { TaskCommand, TaskError } from "#src/task-schema";

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

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
        : cause instanceof WorkerRequestError
          ? new TaskError({ message: cause.message })
          : new TaskError({
              message:
                "Could not reach the task worker. Check it is running. The command was not retried.",
            }),
  });

export const taskResponse = <E extends { readonly message: string }>(
  body: Schema.Json,
  handle: (command: TaskCommand) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const command = Schema.decodeUnknownOption(TaskCommand)(body);

    if (Option.isNone(command))
      return Response.json({ ok: false, message: "Invalid task command." }, { status: 400 });
    const exit = yield* Effect.exit(handle(command.value));

    if (Exit.isSuccess(exit)) return Response.json({ ok: true, value: exit.value });
    const failure = Cause.findErrorOption(exit.cause);

    return Response.json(
      {
        ok: false,
        message: Option.isSome(failure) ? failure.value.message : "The task command failed.",
      },
      { status: 400 },
    );
  });
