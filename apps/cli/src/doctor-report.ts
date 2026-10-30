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

export const unavailable = (id: string, nextStep: string) =>
  finding(
    id,
    "error",
    "not-checked",
    "Inspection could not be completed safely or within its deadline.",
    nextStep,
    true,
  );

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
  ["authentication", "Authentication"],
  ["worker.service", "Background service"],
  ["worker.socket", "Worker connection"],
  ["worker.identity", "Worker configuration"],
  ["tasks", "Scheduled tasks"],
  ["provider-holds", "Provider holds"],
  ["delivery", "Message delivery"],
  ["gateway.connection", "Messaging connections"],
  ["mcp", "MCP servers"],
  ["browser", "Browser"],
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
    (check) => check.status === "warning" || check.status === "error",
  );

  const passed = report.checks.filter((check) => check.status === "ok");
  const skipped = report.checks.filter((check) => check.status === "skipped");
  const warnings = attention.filter((check) => check.status === "warning").length;
  const errors = attention.length - warnings;

  const summary = Match.value(report.exitCode).pipe(
    Match.when(0, () => "No actionable problems found"),
    Match.when(1, () => "Attention needed"),
    Match.orElse(() => "Inspection incomplete"),
  );

  const lines = [
    style("bold", `Poppet doctor: ${summary}`),
    wrap(
      `${passed.length} passed, ${warnings} warning${warnings === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}, ${skipped.length} skipped`,
    ),
    style("gray", `Data directory: ${JSON.stringify(report.dataDirectory)}`),
  ];

  for (const section of [
    { title: "Needs attention", checks: attention },
    { title: "Passed", checks: passed },
    { title: "Skipped", checks: skipped },
  ]) {
    if (section.checks.length === 0) continue;
    lines.push("", style("bold", section.title));

    for (const check of section.checks) {
      const badge = Match.value(check.status).pipe(
        Match.when("ok", () => style("green", "OK   ")),
        Match.when("warning", () => style("yellow", "WARN ")),
        Match.when("error", () => style("red", "ERROR")),
        Match.when("skipped", () => style("gray", "SKIP ")),
        Match.exhaustive,
      );

      lines.push(
        "",
        `  ${badge}  ${style("bold", checkLabels.get(check.id) ?? check.id)} ${style("gray", `[${check.source}]`)}`,
        wrap(check.message, 9),
      );

      if (check.nextStep !== null)
        lines.push(wrap(`Next: ${check.nextStep}`, 9).replace("Next:", style("bold", "Next:")));
    }
  }

  lines.push(
    "",
    style(
      "gray",
      wrap(
        "Local inspection only. Live provider, MCP, browser and messaging access were not verified.",
      ),
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
