import { stripVTControlCharacters, styleText } from "node:util";

import { WorkerRequestError } from "@poppet/worker";
import { Console, Effect, Match, Predicate, Schema } from "effect";

/** Prints the value as JSON when requested, otherwise its human-readable rendering. */
export const printResult = <A>(json: boolean, value: A, render: (value: A) => string) =>
  Console.log(json ? JSON.stringify(value, null, 2) : render(value));

/**
 * Prints a local or worker result as JSON unchanged, or as text from the fields `schema` reads.
 * Worker replies are untyped JSON, so the text form parses them before formatting.
 */
export const printParsed = <A, S extends Schema.Top>(
  json: boolean,
  value: A,
  schema: S,
  render: (parsed: S["Type"]) => string,
) =>
  json
    ? Console.log(JSON.stringify(value, null, 2))
    : Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          () =>
            new WorkerRequestError({
              message:
                "Could not read the command result. If the worker is outdated, restart it to load the current code.",
            }),
        ),
        Effect.flatMap((parsed) => Console.log(render(parsed))),
      );

/** Prints a value from an effect, as JSON or human-readable text. */
export const printWith =
  <A>(json: boolean, render: (value: A) => string) =>
  <E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.flatMap((value) => printResult(json, value, render)));

const color = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export const bold = (text: string) =>
  color() ? styleText("bold", text, { validateStream: false }) : text;

export const dim = (text: string) =>
  color() ? styleText("gray", text, { validateStream: false }) : text;

const width = (text: string) => stripVTControlCharacters(text).length;

const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - width(text)));

// Collapse line breaks so each record stays on one row.
const cell = (value: string) => value.replace(/\s+/gu, " ").trim();

const truncate = (text: string, size: number) =>
  text.length <= size ? text : `${text.slice(0, Math.max(0, size - 1))}…`;

/**
 * Renders aligned columns with a header row. On a terminal, the last column is shortened to fit
 * the window; piped output keeps full values.
 */
export const table = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columns = process.stdout.isTTY ? process.stdout.columns || 100 : Infinity,
) => {
  const cells = rows.map((row) => row.map(cell));

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => (row[index] ?? "").length)),
  );

  const last = headers.length - 1;
  const fixed = widths.slice(0, last).reduce((total, size) => total + size + 2, 0);
  widths[last] = Math.min(widths[last]!, Math.max(headers[last]!.length, columns - fixed));

  const line = (row: ReadonlyArray<string>, style = (text: string) => text) =>
    row
      .map((value, index) =>
        index === last
          ? style(truncate(value, widths[index]!))
          : pad(style(truncate(value, widths[index]!)), widths[index]!),
      )
      .join("  ")
      .trimEnd();

  return [line(headers, bold), ...cells.map((row) => line(row))].join("\n");
};

/** Renders a table, or a message when there are no rows. */
export const tableOr = (
  empty: string,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
) => (rows.length === 0 ? empty : table(headers, rows));

/** Renders labelled values with aligned labels; null entries are omitted. */
export const fields = (entries: ReadonlyArray<readonly [string, string] | null>) => {
  const shown = entries.filter((entry) => entry !== null);
  const size = Math.max(0, ...shown.map(([label]) => label.length + 1));

  return shown
    .map(([label, value]) => `${dim(pad(`${label}:`, size))}  ${value.replaceAll("\n", "\n  ")}`)
    .join("\n");
};

/** Joins titled blocks, skipping empty ones. */
export const sections = (blocks: ReadonlyArray<readonly [string | null, string] | null>) =>
  blocks
    .flatMap((block) =>
      block === null || block[1] === ""
        ? []
        : [block[0] === null ? block[1] : `${bold(block[0])}\n${block[1]}`],
    )
    .join("\n\n");

const two = (value: number) => String(value).padStart(2, "0");

/** A local timestamp in minutes, with a dash for unset times. */
export const time = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return "-";
  const date = new Date(ms);

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

export const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? "unknown" : value ? "yes" : "no";

export const plural = (count: number, noun: string, many = `${noun}s`) =>
  `${count} ${count === 1 ? noun : many}`;

const scalar = (value: Schema.Json) =>
  Match.value(value).pipe(
    Match.when(Predicate.isBoolean, yesNo),
    Match.when(Predicate.isString, (text) => text),
    Match.orElse((other) => (other === null ? "-" : JSON.stringify(other))),
  );

const isList = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isRecord = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !isList(value);

// Scalars and lists of scalars fit on their label's line.
const nested = (value: Schema.Json) =>
  isRecord(value) || (isList(value) && value.some((item) => isList(item) || isRecord(item)));

const acronyms = new Set(["api", "id", "mcp", "pid", "url"]);

/** Turns a camelCase key into a sentence-case label, such as "MCP servers" for mcpServers. */
const label = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(" ")
    .map((word, index) =>
      acronyms.has(word)
        ? word.toUpperCase()
        : index === 0
          ? word.charAt(0).toUpperCase() + word.slice(1)
          : word,
    )
    .join(" ");

/** Renders JSON as indented labelled lines, for provider- or configuration-defined shapes. */
export const tree = (value: Schema.Json, indent = 0): string => {
  const prefix = " ".repeat(indent);

  if (isRecord(value)) {
    const entries = Object.entries(value);

    const size = Math.max(
      0,
      ...entries.flatMap(([key, item]) => (nested(item) ? [] : [label(key).length + 1])),
    );

    return entries
      .map(([key, item]) =>
        nested(item)
          ? `${prefix}${dim(`${label(key)}:`)}\n${tree(item, indent + 2)}`
          : `${prefix}${dim(pad(`${label(key)}:`, size))}  ${tree(item)}`,
      )
      .join("\n");
  }

  if (!isList(value)) return `${prefix}${scalar(value)}`;

  if (!nested(value)) return `${prefix}${value.length === 0 ? "-" : value.map(scalar).join(", ")}`;

  return value.map((item) => `${prefix}-\n${tree(item, indent + 2)}`).join("\n");
};
