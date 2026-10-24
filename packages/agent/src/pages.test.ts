import { describe, expect, test } from "bun:test";

import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { AgentError } from "#src/errors";
import { PageTransport, maxPageBytes, type PageResponse } from "#src/page-network";
import { Pages, PagesLive, decodeFetchPageCall, suppliedPageURLs } from "#src/pages";
import { ChatSettings, defaultPolicy } from "#src/settings";

const encode = (text: string) => new TextEncoder().encode(text);

const response = (text = "Page text", contentType = "text/plain; charset=utf-8"): PageResponse => ({
  status: 200,
  location: undefined,
  contentType,
  body: encode(text),
});

const redirect = (location: string): PageResponse => ({ ...response(), status: 302, location });

const failure = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));

const fixture = (
  transport: Partial<PageTransport["Service"]> = {},
  limit = defaultPolicy.toolBytes,
) =>
  PagesLive.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(PageTransport, {
          resolve: () => Effect.succeed(["93.184.215.14"]),
          request: () => Effect.succeed(response()),
          ...transport,
        }),
        Layer.succeed(ChatSettings, { ...defaultPolicy, toolBytes: limit }),
      ),
    ),
  );

const fetch = (
  url: string,
  transport: Partial<PageTransport["Service"]> = {},
  limit = defaultPolicy.toolBytes,
) => Pages.use((pages) => pages.fetch(url)).pipe(Effect.provide(fixture(transport, limit)));

const call = (url: string, extra = {}) => ({
  type: "tool-call" as const,
  namespace: "poppet_web",
  name: "fetch_page",
  callId: "page",
  arguments: JSON.stringify({ url, ...extra }),
});

describe.concurrent("pages.ts", () => {
  test("when URLs are explicitly supplied, authorizes normalized forms and preserves balanced punctuation", async () => {
    const urls = suppliedPageURLs(
      "Read [this](https://EXAMPLE.com:443/a#section), https://example.com/a_(b). and <http://[2606:4700::1111]/>.",
    );

    expect([...urls]).toEqual([
      "https://example.com/a",
      "https://example.com/a_(b)",
      "http://[2606:4700::1111]/",
    ]);
    expect(
      await Effect.runPromise(decodeFetchPageCall(call("https://example.com/a#other"), urls)),
    ).toBe("https://example.com/a");
    expect(
      await Effect.runPromise(
        failure(decodeFetchPageCall(call("https://example.com/other"), urls)),
      ),
    ).toMatchObject({ reason: "tool-permission" });
    expect(
      await Effect.runPromise(
        failure(decodeFetchPageCall(call("https://example.com/a", { other: true }), urls)),
      ),
    ).toMatchObject({ reason: "tool-arguments" });
  });

  test.each([
    { text: "Read <https://example.com/Yahoo!>", url: "https://example.com/Yahoo!" },
    {
      text: 'Read "https://example.com/report?token=abc;"',
      url: "https://example.com/report?token=abc;",
    },
    { text: "Read `https://example.com/notes.`", url: "https://example.com/notes." },
    { text: "Read 'https://example.com/ready?'", url: "https://example.com/ready?" },
    { text: "Read [this](https://example.com/Yahoo!).", url: "https://example.com/Yahoo!" },
    { text: "Read <https://example.com/path)>", url: "https://example.com/path)" },
  ])(
    "when a URL is explicitly delimited in $text, preserves its punctuation",
    async ({ text, url }) => {
      const urls = suppliedPageURLs(text);

      expect([...urls]).toEqual([url]);
      expect(await Effect.runPromise(decodeFetchPageCall(call(url), urls))).toBe(url);
    },
  );

  test.each([
    "http://127.1",
    "http://2130706433/",
    "http://0x7f000001",
    "https://[::ffff:127.0.0.1]",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "file:///tmp/file",
    "https://example.com/a b",
  ])("when the destination is unsafe or malformed %s, rejects it", async (url) => {
    let requests = 0;
    expect(
      await Effect.runPromise(
        failure(
          fetch(url, {
            resolve: (hostname) => Effect.succeed([hostname]),
            request: () => {
              requests++;

              return Effect.succeed(response());
            },
          }),
        ),
      ),
    ).toBeInstanceOf(AgentError);
    expect(requests).toBe(0);
  });

  test.each([
    { addresses: [] },
    { addresses: ["93.184.215.14", "127.0.0.1"] },
    { addresses: ["2606:4700::1111", "fc00::1"] },
    { addresses: ["::ffff:93.184.215.14"] },
  ])("when DNS returns %j, requires every answer to be public", async ({ addresses }) => {
    expect(
      await Effect.runPromise(
        failure(
          fetch("https://example.com", {
            resolve: () => Effect.succeed(addresses),
            request: () => Effect.die("Must reject before connecting"),
          }),
        ),
      ),
    ).toMatchObject({ reason: "tool-permission" });
  });

  test("when a redirect changes destination, revalidates DNS and pins the address without another lookup", async () => {
    const resolutions: string[] = [];
    const requests: string[] = [];

    const result = await Effect.runPromise(
      fetch("https://first.example/start#fragment", {
        resolve: (hostname) => {
          resolutions.push(hostname);

          return Effect.succeed(["93.184.215.14", "2606:4700::1111"]);
        },
        request: (url, address) => {
          requests.push(`${url.href} ${address}`);

          return Effect.succeed(
            requests.length === 1 ? redirect("https://second.example/end#fragment") : response(),
          );
        },
      }),
    );

    expect(resolutions).toEqual(["first.example", "second.example"]);
    expect(requests).toEqual([
      "https://first.example/start 93.184.215.14",
      "https://second.example/end 93.184.215.14",
    ]);
    expect(JSON.parse(result)).toEqual({
      url: "https://second.example/end",
      title: null,
      text: "Page text",
      truncated: false,
    });
  });

  test("when a same-host redirect resolves privately, rejects DNS rebinding", async () => {
    let resolutions = 0;
    let requests = 0;
    expect(
      await Effect.runPromise(
        failure(
          fetch("https://example.com", {
            resolve: () => Effect.succeed(++resolutions === 1 ? ["93.184.215.14"] : ["127.0.0.1"]),
            request: () => {
              requests++;

              return Effect.succeed(redirect("/next"));
            },
          }),
        ),
      ),
    ).toMatchObject({ reason: "tool-permission" });
    expect(resolutions).toBe(2);
    expect(requests).toBe(1);
  });

  test.each([
    "http://127.0.0.1/",
    "file:///tmp/file",
    "https://user:secret@example.com/",
    "https://example.com:8080/",
  ])("when a redirect targets %s, rejects the destination", async (location) => {
    let requests = 0;
    expect(
      await Effect.runPromise(
        failure(
          fetch("https://example.com", {
            resolve: (hostname) =>
              Effect.succeed(hostname === "127.0.0.1" ? [hostname] : ["93.184.215.14"]),
            request: () => {
              requests++;

              return Effect.succeed(redirect(location));
            },
          }),
        ),
      ),
    ).toBeInstanceOf(AgentError);
    expect(requests).toBe(1);
  });

  test.each([3, 4])(
    "when redirect attempt %i is reached, enforces the three-redirect limit",
    async (count) => {
      let requests = 0;

      const result = await Effect.runPromise(
        Effect.exit(
          fetch("https://example.com", {
            request: () => Effect.succeed(++requests <= count ? redirect("/next") : response()),
          }),
        ),
      );

      expect(Exit.isSuccess(result)).toBe(count === 3);
      expect(requests).toBe(4);
    },
  );

  test("when HTML contains structure and hidden content, extracts readable text and title without scripts or hidden text", async () => {
    const html = await Bun.file(
      new URL("./test/fixtures/pages/article.html", import.meta.url),
    ).text();

    const result = JSON.parse(
      await Effect.runPromise(
        fetch("https://example.com", {
          request: () => Effect.succeed(response(html, "text/html")),
        }),
      ),
    );

    expect(result.title).toBe("Acorn & oak 🌳");
    expect(result.text).toContain("Read this & that today.\nNext paragraph.\nNext line.");
    expect(result.text).toContain("First\nSecond");
    expect(result.text).toContain("Name Value\nOak 42");
    expect(result.text).toContain("<tag> © © ≂̸");
    expect(result.text).toContain("An untrusted link");
    expect(result.text).not.toMatch(/secret|menu-links|site-header|site-footer|Acorn & oak/);
    expect(result.truncated).toBe(false);
  });

  test("when HTML contains preformatted code, preserves its whitespace while normalizing prose", async () => {
    const html = `<p>Before   example.</p><pre><code>if ready:
    deploy()

log(&quot;done&quot;)
	# keep  spacing</code></pre><p>After   example.</p>`;

    const result = JSON.parse(
      await Effect.runPromise(
        fetch("https://example.com", {
          request: () => Effect.succeed(response(html, "text/html")),
        }),
      ),
    );

    expect(result.text).toBe(
      'Before example.\nif ready:\n    deploy()\n\nlog("done")\n\t# keep  spacing\nAfter example.',
    );
  });

  test("when plain text contains UTF-8 and escaping, bounds the serialized result", async () => {
    const plain = await Bun.file(
      new URL("./test/fixtures/pages/plain.txt", import.meta.url),
    ).text();

    const short = JSON.parse(
      await Effect.runPromise(
        fetch("https://example.com", { request: () => Effect.succeed(response(plain)) }),
      ),
    );

    expect(short.text).toBe(plain.trim());

    const content = '🌳"\\'.repeat(5000);

    const output = await Effect.runPromise(
      fetch("https://example.com", { request: () => Effect.succeed(response(content)) }, 1024),
    );

    const result = JSON.parse(output);

    expect(encode(output).byteLength).toBeLessThanOrEqual(1024);
    expect(result).toMatchObject({ truncated: true });
    expect(result.text.length).toBeGreaterThan(0);
    expect(content.startsWith(result.text)).toBe(true);
    expect(result.text.isWellFormed()).toBe(true);
  });

  test.each([
    { ...response(), status: 403 },
    { ...response(), status: 302 },
    response("PDF", "application/pdf"),
    response("Latin", "text/plain; charset=iso-8859-1"),
    response("No", "text/plain; charset=unknown"),
    { ...response(), body: new Uint8Array([0xff]) },
    response("<script>Only JS</script>", "text/html"),
    response("<pre> \n </pre>", "text/html"),
    response('<meta charset="iso-8859-1"><p>Latin</p>', "text/html"),
    response(
      '<meta http-equiv="content-type" content="text/html; charset=windows-1252"><p>Latin</p>',
      "text/html",
    ),
    response("   "),
    response("a".repeat(maxPageBytes + 1)),
  ])(
    "when response case %# is unsupported, empty, failed, or oversized, rejects it",
    async (page) => {
      expect(
        await Effect.runPromise(
          failure(fetch("https://example.com", { request: () => Effect.succeed(page) })),
        ),
      ).toBeInstanceOf(AgentError);
    },
  );

  test.each(["DNS", "body"])(
    "when %s work stalls past the overall deadline, cancels it",
    async (stage) => {
      let cancelled = false;
      await Effect.runPromise(
        Effect.gen(function* () {
          const stalled = Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          );

          const work = fetch(
            "https://example.com",
            stage === "DNS" ? { resolve: () => stalled } : { request: () => stalled },
          );

          const fiber = yield* Effect.forkChild(failure(work));
          yield* TestClock.adjust("15 seconds");
          expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "tool-network" });
          expect(cancelled).toBe(true);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );
});
