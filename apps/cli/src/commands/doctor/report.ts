import { styleText } from "node:util";

import { Match, Schema } from "effect";

export interface DoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warning" | "error" | "skipped";
  readonly source: "local" | "saved" | "worker" | "not-checked";
  readonly observedAt: number;
  readonly message: string;
  readonly nextStep: string | null;
  readonly incomplete: boolean;
}

export const finding = (
  id: string,
  status: DoctorCheck["status"],
  source: DoctorCheck["source"],
  message: string,
  nextStep: string | null = null,
  incomplete = false,
): DoctorCheck => ({ id, status, source, observedAt: Date.now(), message, nextStep, incomplete });

const failedChecks = new Map([
  [
    "authentication",
    "Doctor could not read your sign-in details. The files may be invalid or have unsafe permissions.",
  ],
  [
    "worker.service",
    "Doctor could not read the background service status from the operating system.",
  ],
  ["worker.socket", "Doctor could not read the worker's response. Check its status and logs."],
  [
    "context",
    "Doctor could not read profile.md or soul.md. Check that they are regular UTF-8 files of at most 8 KiB.",
  ],
  [
    "installation",
    "Doctor could not check this data directory. Check that it exists and you can access it.",
  ],
]);

export const unavailable = (
  id: string,
  nextStep: string,
  message = failedChecks.get(id) ??
    "Doctor could not complete this check. Follow the next step for more details.",
) => finding(id, "error", "not-checked", message, nextStep, true);

export const doctorReport = (checks: ReadonlyArray<DoctorCheck>, directory: string | null) => ({
  version: 1 as const,
  dataDirectory: directory,
  observedAt: Date.now(),
  exitCode: checks.some((check) => check.incomplete)
    ? 2
    : checks.some((check) => check.status === "warning" || check.status === "error")
      ? 1
      : 0,
  checks,
});

const checkLabels = new Map([
  ["installation", "Installation"],
  ["configuration", "Configuration"],
  ["authentication", "Provider sign-in"],
  ["worker.service", "Background service"],
  ["worker.socket", "Worker connection"],
  ["worker.identity", "Worker configuration"],
  ["tasks", "Scheduled tasks"],
  ["provider-holds", "Paused provider work"],
  ["delivery", "Message delivery"],
  ["gateway.connection", "Messaging connections"],
  ["mcp", "MCP servers"],
  ["context", "Context files"],
]);

export const renderDoctor = (
  report: ReturnType<typeof doctorReport>,
  color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  columns = process.stdout.columns || 88,
) => {
  const width = Math.max(32, Math.min(columns, 100));

  const style = (format: "green" | "yellow" | "red" | "gray" | "bold", text: string) =>
    color ? styleText(format, text, { validateStream: false }) : text;

  // Wrap plain text before styling so ANSI sequences do not consume visible columns.
  // Keep long paths, IDs and URLs intact rather than inserting characters into them.
  const wrap = (text: string, indent = 0) => {
    const prefix = " ".repeat(indent);
    const lines: string[] = [];
    let line = prefix;

    for (const word of text.split(/\s+/u)) {
      if (line.length > indent && line.length + 1 + word.length > width) {
        lines.push(line);
        line = prefix;
      }

      line += `${line.length > indent ? " " : ""}${word}`;
    }

    lines.push(line);

    return lines.join("\n");
  };

  const attention = report.checks.filter(
    (check) => !check.incomplete && (check.status === "warning" || check.status === "error"),
  );

  const unchecked = report.checks.filter((check) => check.incomplete);
  const passed = report.checks.filter((check) => check.status === "ok");
  const skipped = report.checks.filter((check) => check.status === "skipped");
  const warnings = attention.filter((check) => check.status === "warning").length;
  const errors = attention.length - warnings;

  const summary = Match.value(report.exitCode).pipe(
    Match.when(0, () => "No actionable problems found"),
    Match.when(1, () => "Attention needed"),
    Match.orElse(() => "Some checks could not finish"),
  );

  const lines = [
    style("bold", `Poppet doctor: ${summary}`),
    wrap(
      `${passed.length} passed, ${warnings} warning${warnings === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}, ${unchecked.length} not checked, ${skipped.length} skipped`,
    ),
    style("gray", `Data directory: ${JSON.stringify(report.dataDirectory)}`),
  ];

  for (const section of [
    { title: "Needs attention", checks: attention },
    { title: "Could not check", checks: unchecked },
    { title: "Passed", checks: passed },
    { title: "Skipped", checks: skipped },
  ]) {
    if (section.checks.length === 0) continue;
    lines.push("", style("bold", section.title));

    for (const check of section.checks) {
      const badge = check.incomplete
        ? style("yellow", "UNKNOWN")
        : Match.value(check.status).pipe(
            Match.when("ok", () => style("green", "OK     ")),
            Match.when("warning", () => style("yellow", "WARN   ")),
            Match.when("error", () => style("red", "ERROR  ")),
            Match.when("skipped", () => style("gray", "SKIP   ")),
            Match.exhaustive,
          );

      const source = Match.value(check.source).pipe(
        Match.when("local", () => " [this computer]"),
        Match.when("saved", () => " [saved on disk]"),
        Match.when("worker", () => " [worker report]"),
        Match.when("not-checked", () => ""),
        Match.exhaustive,
      );

      lines.push(
        "",
        `  ${badge}  ${style("bold", checkLabels.get(check.id) ?? check.id)}${style("gray", source)}`,
        wrap(check.message, 11),
      );

      if (check.nextStep !== null)
        lines.push(wrap(`Next: ${check.nextStep}`, 11).replace("Next:", style("bold", "Next:")));
    }
  }

  lines.push(
    "",
    style(
      "gray",
      wrap("Doctor checks local setup. It does not test live connections or send messages."),
    ),
  );

  return lines.join("\n");
};

const Count = Schema.Natural;
const Time = Schema.NullOr(Schema.Natural.check(Schema.isLessThanOrEqualTo(8640000000000000)));

export const DoctorSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  observedAt: Schema.Natural,
  tasks: Schema.Struct({ failed: Count, interrupted: Count, running: Count, nextAt: Time }),
  recent: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
        jobId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
        status: Schema.Literals(["failed", "interrupted"]),
      }),
    ).check(Schema.isMaxLength(5)),
  ),
  holds: Schema.Array(
    Schema.Struct({
      provider: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
      reason: Schema.Literals(["quota", "temporary", "rate-limit", "other"]),
      resumeAt: Time,
    }),
  ).check(Schema.isMaxLength(20)),
  holdsOmitted: Count,
  gateway: Schema.optionalKey(
    Schema.Struct({
      enabled: Count,
      disconnected: Count,
      unknown: Count,
      configurationErrors: Count,
    }),
  ),
  delivery: Schema.Struct({ pending: Count, failed: Count, uncertain: Count }),
});
