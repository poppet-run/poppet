import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { BoundedText, toolArguments } from "#src/tool-schema";
import { webSearchTool } from "#src/web-search";

test("bounds tool text by UTF-8 bytes without trimming or accepting empty values", async () => {
  const decode = toolArguments(webSearchTool, Schema.Struct({ query: BoundedText(4) }));
  expect(await Effect.runPromise(decode('{"query":"éé"}'))).toEqual({ query: "éé" });

  await Promise.all(
    ["", " ", " x", "x ", "ééx"].map(async (query) => {
      await expect(Effect.runPromise(decode(JSON.stringify({ query })))).rejects.toMatchObject({
        reason: "tool-arguments",
        message: "Invalid arguments for poppet_web.search_web.",
      });
    }),
  );
});
