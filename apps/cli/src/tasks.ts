import { AppConfig } from "@poppet/config";
import {
  TaskCommand,
  TaskError,
  nextOccurrence,
  taskOperation,
  type Schedule,
} from "@poppet/tasks";
import { Effect, Schema } from "effect";

export const prepareTask = (
  name: string,
  schedule: Schedule,
  coding: boolean,
  prompt: string,
  skill?: string,
  discordThread?: string,
) =>
  Effect.gen(function* () {
    yield* taskOperation(() => nextOccurrence(schedule, Date.now()));
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        new TaskError({ message: "Set POPPET_MODEL before adding a task." }),
      );

    const command = {
      action: "add",
      task: {
        name,
        schedule,
        prompt,
        provider: config.provider,
        model: config.model,
        workload: coding ? "coding" : "assistant",
      },
    };

    const selected =
      discordThread === undefined
        ? command
        : {
            ...command,
            delivery: { adapter: "discord", conversationId: discordThread },
          };

    return yield* Schema.decodeUnknownEffect(TaskCommand)(
      skill === undefined ? selected : { ...selected, skill },
    ).pipe(
      Effect.mapError(
        () =>
          new TaskError({
            message:
              "Use a nonempty task name up to 128 bytes, a prompt up to 16384 bytes, and a model ID up to 1024 bytes, with no surrounding whitespace. Run bun run start --help.",
          }),
      ),
    );
  });
