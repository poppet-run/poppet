import { fitPrefix, longestFit } from "@poppet/io";
import { StoreError } from "@poppet/store";
import { Effect } from "effect";

import type { Occurrence, Task, TaskTarget } from "#src/task-schema";

export const summary = (task: Task) => ({
  id: task.id,
  name: task.name,
  schedule:
    task.schedule.type === "once"
      ? { type: "once", at: new Date(task.schedule.at).toISOString() }
      : task.schedule,
  paused: task.paused,
  nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString(),
  destination:
    task.destination === null
      ? null
      : { adapter: task.destination.adapter, conversationId: task.destination.conversationId },
});

export const bounded = (output: string, limit: number) =>
  Buffer.byteLength(output) > limit
    ? Effect.fail(
        new StoreError({
          reason: "invalid-request",
          message: "Task details exceed the tool-result budget. Increase POPPET_TOOL_BYTES.",
        }),
      )
    : Effect.succeed(output);

export const listOutput = (rows: ReadonlyArray<Task>, limit: number) => {
  const tasks: ReturnType<typeof summary>[] = [];

  for (const task of rows.slice(0, 10)) {
    const result = summary(task);

    if (
      Buffer.byteLength(
        JSON.stringify({ tasks: [...tasks, result], nextCursor: task.id, truncated: true }),
      ) > limit
    )
      break;
    tasks.push(result);
  }

  if (tasks.length === 0 && rows.length > 0)
    return bounded(
      JSON.stringify({ tasks: [summary(rows[0]!)], nextCursor: rows[0]!.id, truncated: true }),
      limit,
    );
  const truncated = rows.length > tasks.length;

  return Effect.succeed(
    JSON.stringify({ tasks, nextCursor: truncated ? tasks.at(-1)!.id : null, truncated }),
  );
};

export const detailsOutput = (
  task: Task,
  rows: ReadonlyArray<Occurrence>,
  target: TaskTarget | null,
  limit: number,
) => {
  const occurrences = rows.slice(0, 5).map((item) => ({
    id: item.id,
    status: item.status,
    scheduledAt: item.scheduledAt,
    availableAt: item.availableAt,
    origin: item.origin,
    finishedAt: item.finishedAt,
    reason: item.reason,
  }));

  const output = (prompt: string, shown: typeof occurrences, truncated: boolean) =>
    JSON.stringify({
      task: {
        ...summary(task),
        prompt,
        provider: task.provider,
        model: task.model,
        workload: task.workload,
        skill: task.skill?.name ?? null,
      },
      occurrences: shown,
      target,
      truncated,
    });

  const fits = (text: string) => Buffer.byteLength(text) <= limit;
  const whole = output(task.prompt, occurrences, rows.length > 5);

  if (fits(whole)) return Effect.succeed(whole);

  // Shorten the prompt first, then drop occurrences from the end of the list.
  const prompt = fitPrefix(task.prompt, (prefix) => fits(output(prefix, occurrences, true)));

  if (prompt !== null) return Effect.succeed(output(prompt, occurrences, true));

  const shown = longestFit(occurrences.length, (count) =>
    fits(output("", occurrences.slice(0, count), true)),
  );

  return bounded(output("", occurrences.slice(0, Math.max(shown, 0)), true), limit);
};
