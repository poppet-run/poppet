import { toolParameters } from "@poppet/provider";
import type { Tool } from "@poppet/provider";
import type { DeliveryDestination, StoreError } from "@poppet/store";
import { Session, SkillName } from "@poppet/store";
import { Context, Effect, Option, Schema } from "effect";

import { AgentError } from "#src/errors";
import { builtinFailures, reportedStoreReasons } from "#src/tools/agent-tool";
import type { AgentTool, FailurePolicy, PreparedCall, ToolCall } from "#src/tools/agent-tool";
import { BoundedText, toolArguments } from "#src/tools/tool-schema";

const TaskSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: BoundedText(64) }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    expression: BoundedText(256),
    timezone: BoundedText(128),
  }),
]);

const Delivery = Schema.Union([
  Schema.Literals(["local", "here", "home"]),
  Schema.Struct({ conversationId: BoundedText(128) }),
]);

const Arguments = Schema.Struct({
  action: Schema.Literals([
    "create",
    "list",
    "show",
    "pause",
    "resume",
    "delete",
    "edit",
    "skip_next",
    "snooze",
    "run_now",
  ]).annotate({
    description:
      "Operation to perform. Each action reads only its own fields; set unused fields to null.",
  }),
  id: Schema.NullOr(Session.fields.id).annotate({
    description: "Task ID. Required for all actions except create and list.",
  }),
  name: Schema.NullOr(BoundedText(128)).annotate({
    description: "Task name (required for create; optional for edit).",
  }),
  prompt: Schema.NullOr(BoundedText(16_384)).annotate({
    description:
      "Self-contained task prompt (required for create; optional for edit). Each occurrence runs in a fresh session.",
  }),
  schedule: Schema.NullOr(TaskSchedule).annotate({
    description: [
      "Schedule (required for create; optional for edit).",
      "once.at needs an ISO timestamp with Z or offset;",
      "cron needs 5 fields and an explicit IANA timezone.",
    ].join(" "),
  }),
  delivery: Schema.NullOr(Delivery).annotate({
    description: [
      'Delivery target (required for create): "local", "here" (current chat),',
      '"home" (configured home channel), or { conversationId }.',
      'Default to "home" in messaging unless requested otherwise, and "local" in CLI.',
      "Messaging targets are unavailable in CLI.",
    ].join(" "),
  }),
  skill: Schema.NullOr(SkillName).annotate({
    description: "Optional skill name (create); set only when explicitly requested.",
  }),
  after: Schema.NullOr(Session.fields.id).annotate({
    description: "Pagination cursor from a previous list response (list).",
  }),
  until: Schema.NullOr(BoundedText(64)).annotate({
    description: "Future ISO timestamp with Z or offset to delay the next execution (snooze).",
  }),
  endAt: Schema.NullOr(BoundedText(64)).annotate({
    description: [
      "Optional recurring end time as an ISO timestamp with Z or offset",
      "(create/edit; rejected by one-off tasks).",
      "Slots after endAt are not scheduled; a slot exactly at endAt still runs.",
      'Set only when asked; pass "none" in edit to clear.',
    ].join(" "),
  }),
});

export type ChatTaskAction =
  | {
      readonly action: "create";
      readonly name: string;
      readonly prompt: string;
      readonly schedule: typeof TaskSchedule.Type;
      readonly delivery: typeof Delivery.Type;
      readonly skill: string | null;
      readonly endAt: string | null;
    }
  | { readonly action: "list"; readonly after: string | null }
  | { readonly action: "show" | "pause" | "resume" | "delete"; readonly id: string }
  | {
      readonly action: "edit";
      readonly id: string;
      readonly name: string | null;
      readonly prompt: string | null;
      readonly schedule: typeof TaskSchedule.Type | null;
      readonly endAt: string | null;
    }
  | { readonly action: "skip_next" | "run_now"; readonly id: string }
  | { readonly action: "snooze"; readonly id: string; readonly until: string };

export interface ChatTaskContext {
  readonly origin: "interactive" | "scheduled";
  readonly runId: string;
  readonly callId: string;
  readonly here: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly home: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly destination:
    | ((conversationId: string) => Effect.Effect<DeliveryDestination, AgentError>)
    | null;
}

export type PreparedTaskCall = PreparedCall;

export class ChatTasks extends Context.Service<
  ChatTasks,
  {
    readonly prepare: (
      action: ChatTaskAction,
      context: ChatTaskContext,
    ) => Effect.Effect<PreparedTaskCall, AgentError | StoreError>;
  }
>()("poppet/ChatTasks") {}

export const taskDefinition: Tool = {
  name: "manage_tasks",
  namespace: "poppet_tasks",
  description: [
    "Manage the owner's scheduled tasks; mutate only on the owner's explicit current request.",
    "Ask when the task, time, timezone, or prompt is unclear.",
    [
      "- create: requires name, prompt, schedule, delivery (optional skill, endAt).",
      "For another channel or thread, use its ID from the owner's message",
      "(extract numeric ID from Discord <#ID>); ask if only a name is given, never invent an ID.",
      "Explicit destinations must belong to this gateway and pass access checks.",
    ].join(" "),
    "- list: optional after cursor.",
    "- show: inspect one task by id.",
    [
      "- edit: requires id and at least one of name, prompt, schedule, or endAt;",
      "a later or cleared endAt resumes an ended task without replaying missed times.",
    ].join(" "),
    "- pause / resume: pause cancels pending work; resume skips missed recurring times.",
    [
      "- skip_next / snooze / run_now: timing controls act on the next execution",
      "and are rejected while running.",
      "skip_next skips one run; snooze delays it to until without changing cron (survives restart);",
      "run_now queues one run with reviewed Bash access, keeps cadence, and cannot undo a future hold.",
    ].join(" "),
    [
      "- delete: permanently removes the task and occurrence history (retains conversations);",
      "rejected while running (ask the owner to wait or cancel via CLI).",
      "Resolve ambiguous names first.",
    ].join(" "),
    "Report mutations only after a completed receipt; run_now confirms queueing, not execution or delivery.",
  ].join("\n"),
  parameters: toolParameters(Arguments),
};

export const decodeTaskCall = (call: ToolCall): Effect.Effect<ChatTaskAction, AgentError> =>
  Effect.gen(function* () {
    const args = yield* toolArguments(taskDefinition, Arguments)(call.arguments);

    const missing = (fields: Partial<typeof args>) =>
      Effect.fail(
        new AgentError({
          reason: "tool-arguments",
          message: `The ${args.action} action needs ${Object.entries(fields)
            .filter(([, value]) => value === null)
            .map(([field]) => field)
            .join(", ")}.`,
        }),
      );

    const { id, name, prompt, schedule, delivery, until, endAt } = args;

    if (args.action === "create") {
      if (name === null || prompt === null || schedule === null || delivery === null) {
        return yield* missing({ name, prompt, schedule, delivery });
      }

      return { action: "create", name, prompt, schedule, delivery, skill: args.skill, endAt };
    }

    if (args.action === "list") {
      return { action: "list", after: args.after };
    }

    if (id === null) {
      return yield* missing({ id });
    }

    if (args.action === "edit") {
      if (name === null && prompt === null && schedule === null && endAt === null) {
        return yield* Effect.fail(
          new AgentError({
            reason: "tool-arguments",
            message: "The edit action needs at least one of name, prompt, schedule, or endAt.",
          }),
        );
      }

      return { action: "edit", id, name, prompt, schedule, endAt };
    }

    if (args.action === "snooze") {
      if (until === null) {
        return yield* missing({ until });
      }

      return { action: "snooze", id, until };
    }

    return { action: args.action, id };
  });

export const taskFailures: FailurePolicy = {
  reported: new Set([
    ...builtinFailures.reported,
    ...[...reportedStoreReasons].map((reason) => `store:${reason}`),
  ]),
  uncertain: new Set(["store:storage"]),
  otherwise: "fatal",
};

export const taskTool = Effect.gen(function* () {
  const tasks = Option.getOrNull(yield* Effect.serviceOption(ChatTasks));

  if (tasks === null) {
    return null;
  }

  return {
    definition: taskDefinition,
    prepare: (call, { run, origin, here, home, destination }) =>
      decodeTaskCall(call).pipe(
        Effect.flatMap((action) =>
          tasks.prepare(action, {
            origin,
            runId: run.id,
            callId: call.callId,
            here,
            home,
            destination,
          }),
        ),
      ),
    untrustedResult: false,
    withdrawnWhenUntrusted: true,
    contextOnly: false,
    availableWhenScheduled: false,
    failures: taskFailures,
    recordsOwnResult: true,
  } satisfies AgentTool;
});
