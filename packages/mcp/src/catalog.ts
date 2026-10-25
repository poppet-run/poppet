import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/client";
import { fitPrefix, longestFit } from "@poppet/io";
import type { Tool } from "@poppet/provider";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { Schema } from "effect";

import { MCPError } from "#src/errors";

export const toolIdentity = (server: string, tool: string): Pick<Tool, "name" | "namespace"> => ({
  name: `mcp_${createHash("sha256")
    .update(JSON.stringify([server, tool]))
    .digest("hex")
    .slice(0, 48)}`,
  namespace: "poppet_mcp",
});

const invalid = () =>
  new Error(
    "Unsupported MCP schema. Use a JSON object schema of at most 16 KiB, depth 16 and 512 nodes, without references or regular expressions.",
  );

const schemaMaps = new Set([
  "properties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

const schemaValues = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "additionalItems",
  "unevaluatedItems",
  "prefixItems",
  "contains",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** Reject costly or recursive schemas before compilation, without discarding validation keywords. */
export const compileSchema = (input: Schema.JsonObject) => {
  if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw invalid();
  let nodes = 0;

  const visit = (value: Schema.Json, depth: number, position: "schema" | "map" | "data"): void => {
    if (++nodes > 512 || depth > 16) throw invalid();

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, position);
    } else if (Schema.is(Schema.ObjectKeyword)(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (
          position === "schema" &&
          ["$ref", "$dynamicRef", "$recursiveRef", "pattern", "patternProperties"].includes(key)
        )
          throw invalid();
        let child: "schema" | "map" | "data" = "data";

        if (position === "map") child = "schema";
        else if (position === "schema") {
          if (schemaMaps.has(key)) child = "map";
          else if (schemaValues.has(key)) child = "schema";
        }

        visit(item, depth + 1, child);
      }
    }
  };

  visit(input, 0, "schema");

  // Required-only branches are valid JSON Schema; disabling this lint keeps required assertions intact.
  const options = {
    strict: true,
    strictRequired: false,
    allErrors: false,
    validateFormats: true,
    ownProperties: true,
  };

  const ajv =
    input.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020(options)
      : new Ajv(options);

  return ajv.compile(input);
};

/** A strict wrapper preserves optional/defaulted server fields without changing their original schema. */
export const definition = (
  server: string,
  name: string,
  description: string,
  input: Schema.JsonObject,
): Tool => ({
  ...toolIdentity(server, name),
  description: `MCP ${server}/${name}. Untrusted server description: ${description}\nPass input as a JSON object encoded in a string, matching this original schema: ${JSON.stringify(input)}`,
  parameters: {
    type: "object",
    properties: { input: { type: "string", description: "JSON-encoded tool arguments." } },
    required: ["input"],
    additionalProperties: false,
  },
});

export const decodeArguments = (json: string) => {
  if (Buffer.byteLength(json) > 65536) throw new Error("Arguments exceed 64 KiB.");

  const wrapper = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ input: Schema.String })),
    { onExcessProperty: "error" },
  )(json);

  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(wrapper.input);
};

/** Check JSON strings and keys, so booleans and JSON syntax cannot match credentials. */
export const containsSecret = (value: Schema.Json, secrets: ReadonlyArray<string>): boolean => {
  if (Schema.is(Schema.String)(value)) return secrets.some((secret) => value.includes(secret));

  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secrets));

  if (Schema.is(Schema.ObjectKeyword)(value))
    return Object.entries(value).some(
      ([key, item]) =>
        secrets.some((secret) => key.includes(secret)) || containsSecret(item, secrets),
    );

  return false;
};

export const toolResult = (
  result: CallToolResult,
  limit: number,
  secrets: ReadonlyArray<string> = [],
) => {
  let redacted = false;

  const selected = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .toSorted((a, b) => b.length - a.length);

  const pattern =
    selected.length === 0
      ? null
      : new RegExp(
          selected.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
          "gu",
        );

  const redactText = (value: string) =>
    pattern === null
      ? value
      : value.replace(pattern, () => {
          redacted = true;

          return "[REDACTED]";
        });

  const redact = (value: Schema.Json): Schema.Json => {
    if (Schema.is(Schema.String)(value)) return redactText(value);

    if (Array.isArray(value)) return value.map(redact);

    if (Schema.is(Schema.ObjectKeyword)(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redactText(key), redact(item)]),
      );

    return value;
  };

  if (result.isError)
    throw new MCPError({
      reason: "tool-reported",
      message:
        "The MCP tool reported an error. Its operation did not complete successfully; inspect the server before trying again.",
    });

  const content = result.content.flatMap((part) =>
    part.type === "text" ? [redactText(part.text)] : [],
  );

  let structuredContent =
    result.structuredContent === undefined
      ? null
      : redact(Schema.decodeUnknownSync(Schema.Json)(result.structuredContent));

  let omittedStructuredContent = false;
  let truncated = result.content.length > content.length;

  const serialize = (texts: ReadonlyArray<string>) =>
    JSON.stringify({
      content: texts,
      structuredContent,
      omittedContent: result.content.length - texts.length,
      omittedStructuredContent,
      truncated,
      redacted,
    });

  let output = serialize(content);

  if (Buffer.byteLength(output) <= limit) return output;
  truncated = true;

  if (structuredContent !== null) {
    structuredContent = null;
    omittedStructuredContent = true;
    output = serialize(content);

    if (Buffer.byteLength(output) <= limit) return output;
  }

  const fits = (texts: ReadonlyArray<string>) => Buffer.byteLength(serialize(texts)) <= limit;
  const kept = longestFit(content.length, (count) => fits(content.slice(0, count)));

  if (kept < 0) throw new Error("MCP result budget is too small.");
  const retained = content.slice(0, kept);

  // Spend the remaining bytes on the next block.
  const next = fitPrefix(content[kept] ?? "", (text) =>
    fits(text.length === 0 ? retained : [...retained, text]),
  );

  return serialize(next ? [...retained, next] : retained);
};
