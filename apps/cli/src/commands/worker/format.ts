import { Schema } from "effect";

import { fields, plural, sections, table, time, yesNo } from "#src/output";

const Time = Schema.NullOr(Schema.Number);

const Count = Schema.optionalKey(Schema.Number);

/** The status fields that text output shows; JSON output keeps every field. */
export const WorkerStatusReport = Schema.Struct({
  service: Schema.Struct({
    installed: Schema.Boolean,
    active: Schema.Boolean,
    file: Schema.String,
    log: Schema.String,
  }),
  worker: Schema.Struct({
    running: Schema.Boolean,
    pid: Schema.NullOr(Schema.Number),
    startedAt: Time,
    activeOccurrence: Schema.NullOr(Schema.String),
    taskCount: Schema.Number,
    pausedTaskCount: Schema.Number,
    pendingCount: Schema.Number,
    nextScheduledAt: Time,
    providerPauses: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        reason: Schema.String,
        resumeAt: Time,
        action: Schema.String,
      }),
    ),
    recent: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        status: Schema.String,
        scheduledAt: Schema.Number,
        action: Schema.NullOr(Schema.String),
      }),
    ),
    connections: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        connected: Schema.NullOr(Schema.Boolean),
        account: Schema.NullOr(Schema.String),
        action: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
    messaging: Schema.optionalKey(
      Schema.Struct({
        running: Schema.Boolean,
        enabled: Schema.Boolean,
        channels: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            enabled: Schema.Boolean,
            error: Schema.optionalKey(Schema.String),
            lastError: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
        queued: Count,
        executing: Count,
        pendingDelivery: Count,
        failedDelivery: Count,
        uncertainDelivery: Count,
        failedRequests: Count,
      }),
    ),
  }),
});

type WorkerReport = (typeof WorkerStatusReport.Type)["worker"];

const count = (value: number | undefined) => (value === undefined ? "-" : String(value));

const messaging = (status: NonNullable<WorkerReport["messaging"]>) =>
  [
    fields([
      ["Running", yesNo(status.running)],
      ["Enabled", yesNo(status.enabled)],
      ["Queued requests", count(status.queued)],
      ["Executing", count(status.executing)],
      ["Failed requests", count(status.failedRequests)],
      ["Pending deliveries", count(status.pendingDelivery)],
      ["Failed deliveries", count(status.failedDelivery)],
      ["Uncertain deliveries", count(status.uncertainDelivery)],
    ]),
    ...(status.channels.length === 0
      ? []
      : [
          "",
          table(
            ["CHANNEL", "NAME", "ENABLED", "PROBLEM"],
            status.channels.map((channel) => [
              channel.id,
              channel.name,
              yesNo(channel.enabled),
              channel.error ?? channel.lastError ?? "-",
            ]),
          ),
        ]),
  ].join("\n");

export const renderWorkerStatus = ({ service, worker: report }: typeof WorkerStatusReport.Type) =>
  sections([
    [
      "Login service",
      fields([
        ["Installed", yesNo(service.installed)],
        ["Active", yesNo(service.active)],
        ["Service file", service.file],
        ["Log", service.log],
      ]),
    ],
    [
      "Worker",
      fields([
        ["Running", report.running ? `yes, pid ${report.pid}` : "no"],
        report.startedAt === null ? null : ["Started", time(report.startedAt)],
        [
          "Tasks",
          `${plural(report.taskCount, "task")}, ${report.pausedTaskCount} paused, ${report.pendingCount} pending`,
        ],
        ["Next scheduled", time(report.nextScheduledAt)],
        report.activeOccurrence === null ? null : ["Running occurrence", report.activeOccurrence],
      ]),
    ],
    report.connections.length === 0
      ? null
      : [
          "Providers",
          table(
            ["PROVIDER", "CONNECTED", "ACCOUNT", "NEXT STEP"],
            report.connections.map((connection) => [
              connection.provider,
              yesNo(connection.connected),
              connection.account ?? "-",
              connection.action ?? "-",
            ]),
          ),
        ],
    report.providerPauses.length === 0
      ? null
      : [
          "Provider pauses",
          table(
            ["PROVIDER", "REASON", "RESUMES", "NEXT STEP"],
            report.providerPauses.map((pause) => [
              pause.provider,
              pause.reason,
              pause.resumeAt === null ? "manually" : time(pause.resumeAt),
              pause.action,
            ]),
          ),
        ],
    report.recent.length === 0
      ? null
      : [
          "Recent occurrences",
          table(
            ["ID", "TASK", "STATUS", "SCHEDULED", "NEXT STEP"],
            report.recent.map((item) => [
              item.id,
              item.name,
              item.status,
              time(item.scheduledAt),
              item.action ?? "-",
            ]),
          ),
        ],
    report.messaging === undefined ? null : ["Messaging", messaging(report.messaging)],
  ]);
