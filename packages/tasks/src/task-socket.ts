import { requestWorkerReply, workerReply } from "@poppet/worker";
import { Effect, Option, Schema } from "effect";

import { TaskCommand, TaskError, isTaskControl } from "#src/task-schema";

export const remoteTaskCommand = (path: string, command: TaskCommand) =>
  requestWorkerReply(
    path,
    "/v1/tasks",
    command,
    "Could not reach the task worker. Check it is running. The command was not retried.",
    10_000,
  ).pipe(Effect.mapError((error) => new TaskError({ message: error.message })));

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

    return yield* workerReply(
      command.action === "add" || isTaskControl(command)
        ? operation.pipe(Effect.timeout("8 seconds"))
        : operation,
      "The task command failed.",
    );
  });
