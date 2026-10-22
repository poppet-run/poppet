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
        "proposalNote" in command && command.proposalNote !== undefined
          ? "/approval-tasks"
          : "project" in command && command.project !== undefined
            ? "/project-tasks"
            : "/tasks",
        command,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );

      if (response === null) return null;

      if (response.status === 404)
        throw new TaskError({
          message:
            "The worker rejected this command. Restart an outdated worker to load project context support. The command was not retried.",
        });
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
    const command = Option.getOrNull(
      Schema.decodeUnknownOption(TaskCommand, { onExcessProperty: "error" })(body),
    );

    if (command === null)
      return Response.json({ ok: false, message: "Invalid task command." }, { status: 400 });
    const operation = handle(command);

    // Leave time to report failure before the ten-second transport deadline.
    const exit = yield* Effect.exit(
      ["add", "add-monitor", "edit", "skip-next", "snooze", "run-now"].includes(command.action)
        ? operation.pipe(Effect.timeout("8 seconds"))
        : operation,
    );

    if (Exit.isSuccess(exit)) return Response.json({ ok: true, value: exit.value });
    const failure = Option.getOrNull(Cause.findErrorOption(exit.cause));

    return Response.json(
      {
        ok: false,
        message: failure?.message ?? "The task command failed.",
      },
      { status: 400 },
    );
  });
