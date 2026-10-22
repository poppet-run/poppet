import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { decodeToolArguments, toolParameters } from "#src/schema";

test("tool arguments reject malformed JSON, missing fields and nested excess properties", async () => {
  const schema = Schema.Struct({ input: Schema.Struct({ value: Schema.String }) });
  const decode = decodeToolArguments(schema);

  expect(toolParameters(schema)).toMatchObject({
    additionalProperties: false,
    properties: { input: { additionalProperties: false } },
  });
  expect(await Effect.runPromise(decode('{"input":{"value":"ok"}}'))).toEqual({
    input: { value: "ok" },
  });

  await Promise.all(
    [
      "{",
      "null",
      "[]",
      "{}",
      '{"input":{}}',
      '{"input":{"value":"ok"},"extra":true}',
      '{"input":{"value":"ok","extra":true}}',
    ].map(async (json) => {
      await expect(Effect.runPromise(decode(json))).rejects.toBeInstanceOf(Schema.SchemaError);
    }),
  );
});
