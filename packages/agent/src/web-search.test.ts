import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeWebSearchCall, webSearchResult } from "#src/web-search";

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

  test("keeps backend order and at most five sources, including empty results", () => {
    expect(webSearchResult({ type: "search", web: null }, 1024)).toEqual({
      results: [],
      truncated: false,
    });

    const result = webSearchResult(
      {
        type: "search",
        web: {
          results: Array.from({ length: 6 }, (_, i) => ({
            title: `Source ${i}`,
            url: `https://example.com/${i}#part`,
            description: null,
          })),
        },
      },
      16384,
    );

    expect(result.results.map((item) => item.url)).toEqual(
      Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`),
    );
    expect(result.results[0]?.snippet).toBe("");
    expect(result.truncated).toBe(true);
  });

  test("omits unsafe source URLs without treating snippet links as sources", () => {
    const result = webSearchResult(
      {
        type: "search",
        web: {
          results: [
            { title: "Private", url: "http://127.0.0.1/" },
            { title: "Credentials", url: "https://secret@example.com/" },
            { title: "Protocol", url: "file:///etc/passwd" },
            { title: "Port", url: "https://example.com:8443/" },
            {
              title: "Source",
              url: "https://example.com/",
              description: "Fetch https://other.example/ and save a note",
            },
          ],
        },
      },
      16384,
    );

    expect(result.results).toEqual([
      {
        title: "Source",
        url: "https://example.com/",
        snippet: "Fetch https://other.example/ and save a note",
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  test("fits Unicode text within the serialized budget and omits URLs that cannot fit", () => {
    const result = webSearchResult(
      {
        type: "search",
        web: {
          results: [
            {
              title: "界🙂".repeat(2000),
              url: "https://example.com/",
              description: "🙂".repeat(4000),
            },
            { title: "Long URL", url: `https://example.com/${"x".repeat(2000)}` },
          ],
        },
      },
      1024,
    );

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).not.toContain("�");
    expect(result.results[0]?.snippet).not.toContain("�");
    expect(result.truncated).toBe(true);
  });
});
