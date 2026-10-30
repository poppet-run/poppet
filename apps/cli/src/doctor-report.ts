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

export const renderDoctor = (
  report: ReturnType<typeof doctorReport>,
  color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
) => {
  const style = (format: "green" | "yellow" | "red" | "gray" | "bold", text: string) =>
    color ? styleText(format, text, { validateStream: false }) : text;

  return [
    `${style("bold", "Doctor:")} ${Match.value(report.exitCode).pipe(
      Match.when(0, () => "no actionable problems found"),
      Match.when(1, () => "attention needed"),
      Match.orElse(() => "inspection incomplete"),
    )}.`,
    `Data directory: ${JSON.stringify(report.dataDirectory)}`,
    ...report.checks.map((check) => {
      const status = Match.value(check.status).pipe(
        Match.when("ok", () => style("green", "[ok]")),
        Match.when("warning", () => style("yellow", "[warning]")),
        Match.when("error", () => style("red", "[error]")),
        Match.when("skipped", () => style("gray", "[skipped]")),
        Match.exhaustive,
      );

      return `${status} ${style("bold", check.id)}: ${check.message} ${style("gray", `(${check.source})`)}${check.nextStep === null ? "" : `\n  ${style("bold", "Next:")} ${check.nextStep}`}`;
    }),
    style(
      "gray",
      "Local inspection only; live provider, MCP, browser and messaging access were not verified.",
    ),
  ].join("\n");
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
