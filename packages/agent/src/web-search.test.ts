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

describe("web search results", () => {
  test("validates complete bounded query arguments", async () => {
    expect(await Effect.runPromise(decodeWebSearchCall(call('{"query":"current news"}')))).toEqual({
      name: "search_web",
      query: "current news",
    });

    await Promise.all(
      [
        "{",
        '{"query":""}',
        '{"query":" leading"}',
        JSON.stringify({ query: "界".repeat(171) }),
        '{"query":"news","url":"https://example.com"}',
      ].map((args) =>
        expect(Effect.runPromise(decodeWebSearchCall(call(args)))).rejects.toMatchObject({
          reason: "tool-arguments",
        }),
      ),
    );
  });
});
