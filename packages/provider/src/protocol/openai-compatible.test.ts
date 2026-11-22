import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { fetchModelCatalog, inferenceFailure } from "#src/protocol/index";

describe("fetchModelCatalog", () => {
  test.each([
    ["malformed JSON", () => new Response("{"), "invalid-request"],
    [
      "a dropped body",
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("Socket closed"));
            },
          }),
        ),
      "temporary",
    ],
  ] as const)(
    "when the model catalog contains %s, classifies the failure",
    async (_mode, response, reason) => {
      const provider = "test-chat";

      await expect(
        Effect.runPromise(
          fetchModelCatalog({
            provider,
            label: "Test",
            url: "https://provider.invalid/models",
            http: async () => response(),
            headers: {},
            schema: Schema.JsonObject,
            failure: (cause) => inferenceFailure(provider, cause),
          }),
        ),
      ).rejects.toMatchObject({ reason });
    },
  );
});
