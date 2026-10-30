import { Output } from "@poppet/provider";
import { ProviderPause, Schedule, type TaskCommand } from "@poppet/tasks";
import { Schema } from "effect";

import { fields, plural, printParsed, sections, table, tableOr, time, tree } from "#src/output";

const Time = Schema.NullOr(Schema.Number);

/** The task fields that text output shows. */
const TaskRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  schedule: Schedule,
  paused: Schema.Literals([0, 1]),
  nextAt: Time,
  skill: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  destination: Schema.NullOr(
    Schema.Struct({ adapter: Schema.String, conversationId: Schema.String }),
  ),
});

type TaskRow = typeof TaskRow.Type;

const OccurrenceRow = Schema.Struct({ id: Schema.String, jobId: Schema.String });

const TaskDetails = Schema.Struct({
  task: TaskRow,
  target: Schema.NullOr(Schema.Struct({ scheduledAt: Schema.Number, availableAt: Schema.Number })),
  occurrences: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      origin: Schema.String,
      scheduledAt: Schema.Number,
      finishedAt: Time,
      reason: Schema.NullOr(Schema.String),
      delivery: Schema.Array(Schema.Struct({ state: Schema.String })),
      output: Schema.NullOr(Schema.Array(Output)),
      failureReason: Schema.NullOr(Schema.String),
    }),
  ),
  skipped: Schema.Array(
    Schema.Struct({ firstAt: Schema.Number, lastAt: Schema.Number, reason: Schema.String }),
  ),
});

const ControlReceipt = Schema.Struct({
  action: Schema.Literals(["edit", "skip-next", "run-now", "snooze"]),
  taskId: Schema.String,
  changedFields: Schema.Array(Schema.String),
  nextAt: Time,
  paused: Schema.Literals([0, 1]),
  availableAt: Time,
});

const schedule = (value: Schedule) =>
  value.type === "once" ? `once at ${time(value.at)}` : `${value.expression} (${value.timezone})`;

const nextRun = (nextAt: number | null, paused: 0 | 1) =>
  paused ? "paused" : nextAt === null ? "none" : time(nextAt);

const state = (task: TaskRow) =>
  task.paused ? "paused" : task.nextAt === null ? "done" : "active";

const destination = (task: TaskRow) =>
  task.destination === null
    ? "local"
    : `${task.destination.adapter}:${task.destination.conversationId}`;

const deliveries = (rows: ReadonlyArray<{ readonly state: string }>) => {
  if (rows.length === 0) return "-";
  const counts = new Map<string, number>();

  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);

  return [...counts].map(([name, count]) => `${count} ${name}`).join(", ");
};

const outputText = (output: ReadonlyArray<Output> | null) =>
  (output ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();

const listTasks = (tasks: ReadonlyArray<TaskRow>) =>
  tableOr(
    "No tasks. Add one with poppet tasks add.",
    ["ID", "NAME", "SCHEDULE", "NEXT RUN", "STATE", "DELIVERY"],
    tasks.map((task) => [
      task.id,
      task.name,
      schedule(task.schedule),
      nextRun(task.nextAt, task.paused),
      state(task),
      destination(task),
    ]),
  );

const taskFields = (task: TaskRow) =>
  fields([
    ["ID", task.id],
    ["Name", task.name],
    ["Schedule", schedule(task.schedule)],
    ["State", state(task)],
    ["Next run", nextRun(task.nextAt, task.paused)],
    ["Model", `${task.provider} ${task.model}`],
    task.skill === null ? null : ["Skill", task.skill.name],
    ["Delivery", destination(task)],
  ]);

const showTask = ({ task, target, occurrences, skipped }: typeof TaskDetails.Type) => {
  const latest = occurrences.map((item) => outputText(item.output)).find((output) => output !== "");

  return sections([
    [null, taskFields(task)],
    ["Prompt", task.prompt],
    target === null
      ? null
      : [
          "Next execution",
          fields([
            ["Scheduled", time(target.scheduledAt)],
            target.availableAt === target.scheduledAt ? null : ["Ready", time(target.availableAt)],
          ]),
        ],
    [
      "Occurrences",
      tableOr(
        "None yet.",
        ["ID", "STATUS", "ORIGIN", "SCHEDULED", "FINISHED", "DELIVERY", "REASON"],
        occurrences.map((item) => [
          item.id,
          item.status,
          item.origin,
          time(item.scheduledAt),
          time(item.finishedAt),
          deliveries(item.delivery),
          item.failureReason ?? item.reason ?? "-",
        ]),
      ),
    ],
    latest === undefined ? null : ["Latest result", latest],
    skipped.length === 0
      ? null
      : [
          "Skipped",
          table(
            ["FROM", "TO", "REASON"],
            skipped.map((item) => [time(item.firstAt), time(item.lastAt), item.reason]),
          ),
        ],
  ]);
};

const control = (receipt: typeof ControlReceipt.Type) => {
  const next = `Next run: ${nextRun(receipt.nextAt, receipt.paused)}.`;

  switch (receipt.action) {
    case "edit":
      return `Updated ${receipt.changedFields.join(", ") || "nothing"} for task ${receipt.taskId}. ${next}`;
    case "skip-next":
      return `Skipped the next execution of task ${receipt.taskId}. ${next}`;
    case "run-now":
      return `Queued an execution of task ${receipt.taskId}.`;
    case "snooze":
      return `Snoozed task ${receipt.taskId} until ${time(receipt.availableAt)}.`;
  }
};

const providerPauses = (pauses: ReadonlyArray<ProviderPause>) =>
  pauses.length === 0
    ? "No provider pauses. Scheduled requests can run."
    : [
        table(
          ["PROVIDER", "REASON", "RESUMES", "FAILURES"],
          pauses.map((pause) => [
            pause.provider,
            pause.reason,
            pause.resumeAt === null ? "manually" : time(pause.resumeAt),
            String(pause.failures),
          ]),
        ),
      ].join("\n");

/** Prints a task command's result; local results and worker replies share each action's shape. */
export const printTaskResult = <A>(json: boolean, command: TaskCommand, value: A) => {
  switch (command.action) {
    case "list":
      return printParsed(json, value, Schema.Array(TaskRow), listTasks);
    case "show":
      return printParsed(json, value, TaskDetails, showTask);
    case "add":
      return printParsed(
        json,
        value,
        TaskRow,
        (task) => `Added task ${task.name}.\n\n${taskFields(task)}`,
      );
    case "edit":
    case "skip-next":
    case "run-now":
    case "snooze":
      return printParsed(json, value, ControlReceipt, control);
    case "pause":
      return printParsed(
        json,
        value,
        TaskRow,
        (task) => `Paused task ${task.name}. Pending work was cancelled.`,
      );
    case "resume":
      return printParsed(
        json,
        value,
        TaskRow,
        (task) => `Resumed task ${task.name}. Next run: ${nextRun(task.nextAt, 0)}.`,
      );
    case "cancel":
    case "cancel-task":
      return printParsed(
        json,
        value,
        OccurrenceRow,
        (item) => `Cancelled occurrence ${item.id} of task ${item.jobId}.`,
      );
    case "retry":
    case "retry-task":
      return printParsed(
        json,
        value,
        OccurrenceRow,
        (item) => `Queued a retry of occurrence ${item.id} for task ${item.jobId}.`,
      );
    case "delete":
      return printParsed(
        json,
        value,
        Schema.Struct({ name: Schema.String }),
        (task) => `Removed task ${task.name} and its history.`,
      );
    case "clear":
      return printParsed(
        json,
        value,
        Schema.Struct({ cleared: Schema.Number }),
        (result) => `Removed ${plural(result.cleared, "task")} and their history.`,
      );
    case "providers":
      return printParsed(json, value, Schema.Array(ProviderPause), providerPauses);
    case "resume-provider":
      return printParsed(
        json,
        value,
        Schema.Struct({ provider: Schema.String }),
        (result) => `Resumed scheduled requests for ${result.provider}.`,
      );
    case "status":
      return printParsed(json, value, Schema.Json, (status) => tree(status));
  }
};
