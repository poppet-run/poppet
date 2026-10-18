import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/client";
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

/** Reject costly or recursive schemas before compilation, without discarding validation keywords. */
export const compileSchema = (input: Schema.JsonObject) => {
  if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw invalid();
  let nodes = 0;

  const visit = (value: Schema.Json, depth: number): void => {
    if (++nodes > 512 || depth > 16) throw invalid();

    if (Schema.is(Schema.Array(Schema.Json))(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (Schema.is(Schema.JsonObject)(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (["$ref", "$dynamicRef", "$recursiveRef", "pattern", "patternProperties"].includes(key))
          throw invalid();
        visit(item, depth + 1);
      }
    }
  };

  visit(input, 0);
  const options = { strict: true, allErrors: false, validateFormats: true, ownProperties: true };

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

    if (Schema.is(Schema.Array(Schema.Json))(value)) return value.map(redact);

    if (Schema.is(Schema.JsonObject)(value))
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

  let content = result.content.flatMap((part) =>
    part.type === "text" ? [Schema.decodeUnknownSync(Schema.String)(redact(part.text))] : [],
  );

  let structuredContent =
    result.structuredContent === undefined
      ? null
      : redact(Schema.decodeUnknownSync(Schema.Json)(result.structuredContent));

  let omittedStructuredContent = false;
  const omittedContent = result.content.length - content.length;
  let truncated = omittedContent > 0;

  const serialize = () =>
    JSON.stringify({
      content,
      structuredContent,
      omittedContent,
      omittedStructuredContent,
      truncated,
      redacted,
    });

  let output = serialize();

  while (Buffer.byteLength(output) > limit) {
    truncated = true;

    if (structuredContent !== null) {
      structuredContent = null;
      omittedStructuredContent = true;
    } else {
      const index = content.findIndex((text) => text.length > 0);

      if (index < 0) {
        content = [];

        if (Buffer.byteLength(serialize()) > limit)
          throw new Error("MCP result budget is too small.");
      } else {
        let text = content[index]!.slice(0, Math.floor(content[index]!.length / 2));

        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        content[index] = text;
      }
    }

    output = serialize();
  }

  return output;
};
