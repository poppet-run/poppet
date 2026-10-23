import { expect, test } from "bun:test";

import type { ModelDescription } from "@poppet/provider";
import { chatCompletionsModel, responsesModel } from "@poppet/provider/protocol";
import { Effect, Schema, Stream } from "effect";
import OpenAI from "openai";

import { compileSchema, definition, toolIdentity, toolResult } from "#src/catalog";

test("tool identities cannot collide through ambiguous concatenation or punctuation", () => {
  const names = [
    ["a-b", "c"],
    ["a", "b-c"],
    ["a", "b.c"],
    ["a", "b_c"],
    ["a", "save_note"],
  ].map(([server, tool]) => toolIdentity(server!, tool!));

  expect(new Set(names.map((name) => name.name)).size).toBe(names.length);
  expect(
    names.every(
      (name) =>
        /^[a-z][a-z0-9_]{0,63}$/.test(name.name) &&
        name.namespace === "poppet_mcp" &&
        `${name.namespace}__${name.name}`.length <= 64,
    ),
  ).toBe(true);
});

test("validates 2020-12 without coercion, defaults, or silently ignoring unsupported schemas", () => {
  const validate = compileSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { count: { type: "integer", default: 2 } },
    additionalProperties: false,
  });

  const empty = {};
  expect(validate(empty)).toBe(true);
  expect(empty).toEqual({});
  expect(validate({ count: "2" })).toBe(false);
  expect(() => compileSchema({ type: "object", $ref: "https://example.com/schema" })).toThrow(
    "Unsupported MCP schema",
  );
  expect(() =>
    compileSchema({ type: "object", properties: { value: { type: "string", format: "unknown" } } }),
  ).toThrow();
  let nested: Schema.JsonObject = { type: "object" };

  for (let i = 0; i < 20; i++) nested = { type: "object", properties: { nested } };
  expect(() => compileSchema(nested)).toThrow("Unsupported MCP schema");
});

test("distinguishes schema keywords from property names and literal data", () => {
  const literal = { pattern: "a", $ref: "literal", patternProperties: {} };

  const validate = compileSchema({
    type: "object",
    properties: {
      pattern: { type: "string" },
      $ref: { type: "string" },
      patternProperties: { type: "object", const: literal, default: literal, examples: [literal] },
    },
    additionalProperties: false,
  });

  expect(validate({ pattern: "text", $ref: "value", patternProperties: literal })).toBe(true);
  expect(validate({ pattern: 1 })).toBe(false);
  expect(() =>
    compileSchema({
      type: "object",
      properties: { values: { type: "array", items: { $ref: "#/definitions/value" } } },
      definitions: { value: { type: "string" } },
    }),
  ).toThrow("Unsupported MCP schema");
  expect(() =>
    compileSchema({
      type: "object",
      $defs: { value: { anyOf: [{ type: "string", pattern: "a" }] } },
    }),
  ).toThrow("Unsupported MCP schema");
});

test("rejects regular expressions in tool schemas", () => {
  for (const pattern of ["(a+)+$", "^a+$", ".*"])
    expect(() => compileSchema({ type: "string", pattern })).toThrow("Unsupported MCP schema");
});

test("required-only output branches still enforce every original assertion", () => {
  const validate = compileSchema({
    type: "object",
    properties: { code: { type: "string" }, status: { type: "string" } },
    additionalProperties: false,
    anyOf: [{ required: ["code"] }, { required: ["status"] }],
  });

  expect(validate({ code: "permission_denied" })).toBe(true);
  expect(validate({ status: "refused" })).toBe(true);
  expect(validate({})).toBe(false);
  expect(validate({ code: 7 })).toBe(false);
  expect(validate({ code: "refused", extra: true })).toBe(false);
});

test("omits oversized structured content and explicitly marks valid bounded serialization", () => {
  const output = toolResult(
    {
      content: [{ type: "text", text: "🌻".repeat(400) }],
      structuredContent: { text: "🌻".repeat(400) },
    },
    512,
  );

  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512);
  expect(JSON.parse(output)).toMatchObject({
    omittedStructuredContent: true,
    structuredContent: null,
    truncated: true,
  });
  expect(output).not.toContain("�");
  expect(output).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
});

test("retains a useful prefix of many text blocks and counts dropped blocks", () => {
  const content = Array.from({ length: 8000 }, (_, i) => ({
    type: "text" as const,
    text: String(i),
  }));

  const output = toolResult({ content }, 1024);
  const result = JSON.parse(output);

  expect(Buffer.byteLength(JSON.stringify({ content }))).toBeLessThan(262144);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
  expect(result.truncated).toBe(true);
  expect(result.content.length).toBeGreaterThan(100);
  expect(result.content.slice(0, -1)).toEqual(
    content.slice(0, result.content.length - 1).map((part) => part.text),
  );
  expect(content[result.content.length - 1]!.text.startsWith(result.content.at(-1))).toBe(true);
  expect(result.omittedContent).toBe(content.length - result.content.length);
});

test("redacts secret values and keys in one pass without expanding earlier redaction markers", () => {
  const output = toolResult(
    { content: [{ type: "text", text: "AD" }], structuredContent: { A: "D" } },
    1024,
    ["A", "D"],
  );

  expect(JSON.parse(output)).toMatchObject({
    content: ["[REDACTED][REDACTED]"],
    structuredContent: { "[REDACTED]": "[REDACTED]" },
    redacted: true,
  });
});

test("treats credential punctuation literally during redaction", () => {
  const output = toolResult({ content: [{ type: "text", text: "axb a.b $token [" }] }, 1024, [
    "a.b",
    "$token",
    "[",
  ]);

  expect(JSON.parse(output).content).toEqual(["axb [REDACTED] [REDACTED] [REDACTED]"]);
});

const description: ModelDescription = {
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  capabilities: { tools: true, generationSettings: [], contextWindow: null, maxOutputTokens: null },
};

test.each(["responses", "chat-completions"] as const)(
  "encodes optional MCP arguments for %s tool calls",
  async (protocol) => {
    const tool = definition("server", "a-long.tool/name", "Fixture", {
      type: "object",
      properties: { optional: { type: "string" } },
    });

    let requested = false;

    const client = new OpenAI({
      apiKey: "fixture",
      baseURL: "https://fixture.invalid/v1",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

        const body = Schema.decodeUnknownSync(Schema.JsonObject)(await request.json());
        requested = true;

        const parameters = {
          type: "object",
          properties: { input: { type: "string", description: "JSON-encoded tool arguments." } },
          required: ["input"],
          additionalProperties: false,
        };

        if (protocol === "responses") {
          expect(body.tools).toEqual([
            {
              type: "namespace",
              name: "poppet_mcp",
              description: "Poppet local tools.",
              tools: [
                {
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters,
                  strict: true,
                },
              ],
            },
          ]);

          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", id: "answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] }] } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }

        const name = `${tool.namespace}__${tool.name}`;
        expect(name.length).toBeLessThanOrEqual(64);
        expect(body.tools).toEqual([
          { type: "function", function: { name, description: tool.description, parameters } },
        ]);

        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const model =
      protocol === "responses"
        ? responsesModel(description, Effect.succeed(client))
        : chatCompletionsModel(description, Effect.succeed(client));

    const events = await Effect.runPromise(
      model
        .stream({
          sessionId: "fixture",
          workload: "assistant",
          instructions: "Fixture",
          messages: [{ role: "user", text: "Use MCP" }],
          tools: [tool],
          settings: {},
        })
        .pipe(Stream.runCollect),
    );

    expect(requested).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { output: [{ type: "text", text: "Done" }] },
    });
  },
);
