import { describe, expect, test } from "bun:test";

import { boundedFetch } from "#src/transport";

describe("boundedFetch", () => {
  test.each([
    ["OAuth response", 200, undefined],
    ["HTTP error response", 401, 64],
    ["successful event stream", 200, 32],
  ] as const)(
    "when an SSE-labelled %s exceeds its total byte limit, stops reading",
    async (_case, status, streamLimit) => {
      const fetch = boundedFetch(
        16,
        async () =>
          new Response("data: x\n\n".repeat(5), {
            status,
            headers: { "content-type": "text/event-stream" },
          }),
        streamLimit,
      );

      const response = await fetch("https://test.invalid");
      await expect(response.text()).rejects.toThrow("size limit");
    },
  );

  test("when a successful SSE response stays within both limits, reads successive events", async () => {
    const text = "data: x\n\n".repeat(4);

    const fetch = boundedFetch(
      16,
      async () =>
        new Response(text, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      64,
    );

    expect(await (await fetch("https://test.invalid")).text()).toBe(text);
  });
});
