import { Array, Cause, Console, Effect, Logger, References } from "effect";

export type LogValue = string | number | boolean | null | undefined;

const bare = /^[^\s"=\\]+$/;

const quote = (text: string) => (bare.test(text) ? text : JSON.stringify(text));

const field = (key: string, value: LogValue) =>
  value === undefined || value === null ? [] : [`${key}=${quote(String(value))}`];

// Bun colours the global console.error red on a terminal, so plain lines bypass it.
const writeLine = (output: Console.Console, line: string) => {
  if (output === globalThis.console) {
    process.stderr.write(`${line}\n`);
  } else {
    output.error(line);
  }
};

/** Writes one diagnostic line to standard error through the current console. */
export const writeDiagnostic = (line: string) =>
  Console.consoleWith((output) => Effect.sync(() => writeLine(output, line)));

/** Formats one logfmt line: `time=… level=… msg=…` followed by the fields in order. */
export const formatLogLine = (
  date: Date,
  level: string,
  message: string,
  fields: Readonly<Record<string, LogValue>> = {},
) =>
  [
    `time=${date.toISOString()}`,
    `level=${level.toLowerCase()}`,
    `msg=${quote(message)}`,
    ...Object.entries(fields).flatMap(([key, value]) => field(key, value)),
  ].join(" ");

/** Writes Effect log entries as logfmt lines to the fiber's console error stream. */
export const logfmtLogger = Logger.make(({ cause, date, fiber, logLevel, message }) => {
  const annotations = Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(
    ([key, value]) => [key, value === undefined || value === null ? null : String(value)] as const,
  );

  const failure = cause.reasons.length > 0 ? [["cause", Cause.pretty(cause)] as const] : [];

  const line = formatLogLine(
    date,
    logLevel,
    Array.ensure(message).map(String).join(" "),
    Object.fromEntries([...annotations, ...failure]),
  );

  writeLine(fiber.getRef(Console.Console), line);
});

export const LogfmtLoggerLive = Logger.layer([logfmtLogger]);
