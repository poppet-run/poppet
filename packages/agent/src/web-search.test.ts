import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeWebSearchCall } from "#src/web-search";

const call = (args: string) => ({
  type: "tool-call" as const,
  name: "search_web",
  namespace: "poppet_web",
  callId: "search",
  arguments: args,
});

describe("decodeWebSearchCall", () => {
  test("when query arguments are supplied, accepts complete bounded text and rejects invalid fields or limits", async () => {
    const query = "é".repeat(256);
    expect(await Effect.runPromise(decodeWebSearchCall(call(JSON.stringify({ query }))))).toBe(
      query,
    );

    await Promise.all(
      [
        "{",
        '{"query":""}',
        '{"query":" "}',
        '{"query":" leading"}',
        '{"query":"trailing "}',
        JSON.stringify({ query: `${query}x` }),
        JSON.stringify({ query: "界".repeat(171) }),
        '{"query":"news","url":"https://example.com"}',
      ].map((args) =>
        expect(Effect.runPromise(decodeWebSearchCall(call(args)))).rejects.toMatchObject({
          reason: "tool-arguments",
          message: "Invalid arguments for poppet_web.search_web.",
        }),
      ),
    );
  });
});
