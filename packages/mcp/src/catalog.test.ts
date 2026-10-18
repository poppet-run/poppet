import { expect, test } from "bun:test";

import { Schema } from "effect";

import { compileSchema, toolIdentity, toolResult } from "#src/catalog";

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
  expect(toolIdentity("a", "b.c")).toEqual(toolIdentity("a", "b.c"));
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
