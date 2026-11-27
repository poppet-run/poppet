import { describe, expect, test } from "bun:test";

import { completeModel, verifyModel } from "@poppet/provider";
import type { ModelRequest } from "@poppet/provider";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeGeminiProvider } from "#src/service";
import type { HttpFetch } from "#src/service";

const baseUrl = "https://gemini.invalid/v1beta";

const request: ModelRequest = {
  sessionId: "gemini-session",
  instructions: "Test",
  messages: [{ role: "user", text: "Hello" }],
  tools: [],
  settings: {},
};

const catalogEntry = (
  id: string,
  extra: { readonly [key: string]: Schema.Json } = {},
  methods = ["generateContent", "countTokens"],
): Schema.JsonObject =>
  // A null in `extra` leaves the field out, as the API does for missing metadata.
  Object.fromEntries(
    Object.entries({
      name: `models/${id}`,
      displayName: id.toUpperCase(),
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: methods,
      temperature: 1,
      thinking: true,
      ...extra,
    }).filter(([, value]) => value !== null),
  );

const sse = (events: ReadonlyArray<Schema.JsonObject>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });

const text = (value: string, extra: { readonly [key: string]: Schema.Json } = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: value }] }, index: 0, ...extra }],
});

const usage = { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 };

const toolResponse = (body: Schema.JsonObject) => {
  const json = JSON.stringify(body);
  const proof = json.match(/poppet_verified_[a-f0-9]+/)?.[0];

  if (proof) {
    return sse([
      text(proof.slice(0, 10)),
      { ...text(proof.slice(10), { finishReason: "STOP" }), usageMetadata: usage },
    ]);
  }

  const challenge = json.match(/challenge ([a-f0-9]+)/)?.[1] ?? "";

  return sse([
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Checking ", thought: true }],
          },
        },
      ],
    },
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "the tool", thought: true },
              {
                functionCall: {
                  name: "poppet_verification__get_verification_token",
                  args: { challenge },
                },
                thoughtSignature: "signed-call",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: usage,
    },
  ]);
};

const fixture = (
  catalog: ReadonlyArray<Schema.JsonObject> = [catalogEntry("gemini-test")],
  respond: (body: Schema.JsonObject) => Response = toolResponse,
) => {
  const requests: Array<{ url: URL; headers: Headers; body: Schema.JsonObject }> = [];
  const catalogRequests: Array<{ url: URL; headers: Headers }> = [];
  const signals: Array<AbortSignal> = [];
  let keyReads = 0;

  const http: HttpFetch = async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const url = new URL(incoming.url);

    if (url.pathname.endsWith("/models")) {
      catalogRequests.push({ url, headers: incoming.headers });

      return Response.json({ models: catalog });
    }

    signals.push(incoming.signal);

    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await incoming.json());
    requests.push({ url, body, headers: incoming.headers });

    return respond(body);
  };

  const key = Effect.sync(() => {
    keyReads++;

    return Redacted.make("gemini-test-secret");
  });

  return {
    provider: makeGeminiProvider(key, http, baseUrl),
    requests,
    catalogRequests,
    signals,
    keyReads: () => keyReads,
  };
};

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
  );

const stall =
  (signals: Array<AbortSignal>, reading: PromiseWithResolvers<void>): HttpFetch =>
  async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    if (new URL(incoming.url).pathname.endsWith("/models")) {
      return Response.json({ models: [catalogEntry("gemini-test")] });
    }

    signals.push(incoming.signal);

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(text("partial"))}\n\n`),
        );
        incoming.signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
      pull: () => {
        reading.resolve();
      },
    });

    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };

const withImage = (mediaType: "image/png" | "image/gif"): ModelRequest => ({
  ...request,
  messages: [
    {
      role: "user",
      text: "Look",
      attachments: [{ id: "image-1", name: "image", mediaType, size: 5 }],
    },
  ],
  attachments: [{ id: "image-1", base64: "aW1hZ2U=" }],
});

const continued = (data: Schema.JsonObject, provider = "gemini"): ModelRequest => ({
  ...request,
  messages: [
    ...request.messages,
    {
      role: "assistant",
      output: [{ type: "text", text: "Hi" }],
      continuation: { version: 1, provider, model: "gemini-test", data },
    },
  ],
});

const quotaFailure = (quotaId: string) => ({
  "@type": "type.googleapis.com/google.rpc.QuotaFailure",
  violations: [{ quotaId }],
});

describe("makeGeminiProvider", () => {
  test("when the catalog spans pages with malformed and non-chat entries, lists chat models with their limits", async () => {
    const first = {
      models: [
        catalogEntry("gemini-test"),
        catalogEntry("gemini-fixed", { temperature: null, thinking: false }),
        catalogEntry("gemini-embedding-001", {}, ["embedContent"]),
        catalogEntry("gemini-2.5-flash-image"),
        catalogEntry("gemini-2.5-flash-preview-tts"),
        { name: "models/gemini-malformed" },
      ],
      nextPageToken: "second",
    };

    const second = {
      models: [
        catalogEntry("gemma-3-27b-it"),
        catalogEntry("veo-3.0-generate-001", {}, ["predictLongRunning"]),
        catalogEntry("gemini-later", { inputTokenLimit: null, displayName: null }),
      ],
    };

    const urls: Array<URL> = [];
    const headers: Array<Headers> = [];

    const provider = makeGeminiProvider(
      Effect.succeed(Redacted.make("gemini-test-secret")),
      async (input, init) => {
        const incoming = new Request(input.toString(), init);
        const url = new URL(incoming.url);
        urls.push(url);
        headers.push(incoming.headers);

        return Response.json(url.searchParams.get("pageToken") === "second" ? second : first);
      },
      baseUrl,
    );

    const models = await Effect.runPromise(provider.models);

    expect(models).toEqual([
      {
        provider: "gemini",
        id: "gemini-test",
        name: "GEMINI-TEST",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["temperature", "maxOutputTokens"],
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
        },
      },
      {
        provider: "gemini",
        id: "gemini-fixed",
        name: "GEMINI-FIXED",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["maxOutputTokens"],
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
        },
      },
      {
        provider: "gemini",
        id: "gemini-later",
        name: "gemini-later",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["temperature", "maxOutputTokens"],
          contextWindow: null,
          maxOutputTokens: 65_536,
        },
      },
    ]);
    expect(urls.map((url) => url.searchParams.get("pageToken"))).toEqual([null, "second"]);
    expect(urls.every((url) => !url.searchParams.has("key"))).toBe(true);
    expect(headers.map((entry) => entry.get("x-goog-api-key"))).toEqual([
      "gemini-test-secret",
      "gemini-test-secret",
    ]);
    expect(headers[0]?.get("user-agent")).toBe("poppet/0.0.0");
  });

  test("when the catalog repeats a page token or every entry is malformed, reports an unsupported catalog", async () => {
    for (const body of [
      { models: [catalogEntry("gemini-test")], nextPageToken: "loop" },
      { models: [{ name: "secret-provider-details" }] },
    ]) {
      const provider = makeGeminiProvider(
        Effect.succeed(Redacted.make("gemini-test-secret")),
        async () => Response.json(body),
        baseUrl,
      );

      const failure = await failureOf(provider.models);

      expect(failure).toMatchObject({
        provider: "gemini",
        reason: "invalid-request",
        message: "Gemini returned an unsupported model catalog.",
      });
      expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
    }
  });

  test("when catalog discovery times out, aborts its stalled body", async () => {
    const reading = Promise.withResolvers<void>();
    const signals: Array<AbortSignal> = [];

    const http: HttpFetch = async (input, init) => {
      const incoming = new Request(input.toString(), init);
      signals.push(incoming.signal);

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{"models":['));
          incoming.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
        pull: () => {
          reading.resolve();
        },
      });

      return new Response(body, { headers: { "Content-Type": "application/json" } });
    };

    const provider = makeGeminiProvider(Effect.succeed(Redacted.make("key")), http, baseUrl);

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* provider.models.pipe(
          Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
          Effect.forkChild,
        );

        yield* Effect.promise(() => reading.promise);
        yield* TestClock.adjust("30 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(failure).toMatchObject({
      reason: "temporary",
      message: "Gemini model discovery timed out.",
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("when resolving repeatedly, caches the catalog per key for 60 seconds and does not cache errors", async () => {
    let reads = 0;
    let fail = true;
    let secret = "first-secret";

    const provider = makeGeminiProvider(
      Effect.sync(() => Redacted.make(secret)),
      async () => {
        reads++;

        return fail
          ? Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 })
          : Response.json({ models: [catalogEntry("gemini-test")] });
      },
      baseUrl,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* provider.resolve("gemini-test").pipe(Effect.isFailure)).toBe(true);
        fail = false;
        yield* provider.resolve("gemini-test");
        yield* provider.resolve("gemini-test");
        expect(reads).toBe(2);

        secret = "second-secret";
        yield* provider.resolve("gemini-test");
        expect(reads).toBe(3);

        yield* TestClock.adjust("60 seconds");
        yield* provider.resolve("gemini-test");
        expect(reads).toBe(4);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("when a model ID is not in the catalog, rejects it without a fallback", async () => {
    const harness = fixture([catalogEntry("gemini-test"), catalogEntry("gemini-2.5-flash-image")]);

    for (const id of ["gemini-missing", "gemini-2.5-flash-image", "models/gemini-test"]) {
      expect(await failureOf(harness.provider.resolve(id))).toMatchObject({
        reason: "invalid-request",
        message: "Choose a Gemini model ID from the Gemini catalog. No model fallback is allowed.",
      });
    }
  });

  test("when tools round-trip with thought signatures, streams reasoning and replays the signed call", async () => {
    const harness = fixture();
    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));
    await Effect.runPromise(verifyModel(model));

    expect(harness.requests).toHaveLength(2);

    for (const outgoing of harness.requests) {
      expect(outgoing.url.pathname).toBe("/v1beta/models/gemini-test:streamGenerateContent");
      expect(outgoing.url.search).toBe("?alt=sse");
      expect(outgoing.headers.get("x-goog-api-key")).toBe("gemini-test-secret");
      expect(outgoing.headers.get("user-agent")).toBe("poppet/0.0.0");
      expect(JSON.stringify(outgoing.body)).not.toContain("gemini-test-secret");
    }

    expect(harness.requests[0]?.body).toMatchObject({
      systemInstruction: {
        parts: [{ text: "Verify the local coding tool exactly once. Return its token verbatim." }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "poppet_verification__get_verification_token",
              parametersJsonSchema: { type: "object", required: ["challenge"] },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    });

    const second = harness.requests[1]?.body;
    expect(second?.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(second?.contents).toMatchObject([
      { role: "user" },
      {
        role: "model",
        parts: [
          { text: "Checking the tool", thought: true },
          {
            functionCall: { name: "poppet_verification__get_verification_token" },
            thoughtSignature: "signed-call",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "poppet_verification__get_verification_token",
              response: { output: expect.stringContaining("poppet_verified_") },
            },
          },
        ],
      },
    ]);
  });

  test("when reasoning summaries are requested, asks a thinking model for thoughts and keeps them out of the answer", async () => {
    const harness = fixture(undefined, () =>
      sse([
        {
          candidates: [
            { content: { parts: [{ text: "Considering", thought: true }, { text: "Hel" }] } },
          ],
        },
        text("lo", { finishReason: "STOP" }),
        { candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: usage },
      ]),
    );

    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));

    const events = await Effect.runPromise(
      Stream.runCollect(
        model.stream({
          ...request,
          settings: { reasoningSummary: true, temperature: 0.5, maxOutputTokens: 100 },
        }),
      ),
    );

    expect(events).toEqual([
      { type: "reasoning-delta", text: "Considering" },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "completed",
        response: {
          output: [{ type: "text", text: "Hello" }],
          continuation: {
            version: 1,
            provider: "gemini",
            model: "gemini-test",
            data: {
              protocol: "generate-content",
              parts: [{ text: "Considering", thought: true }, { text: "Hello" }],
              calls: [],
            },
          },
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 6 },
        },
      },
    ]);
    expect(harness.requests[0]?.body.generationConfig).toEqual({
      temperature: 0.5,
      maxOutputTokens: 100,
      thinkingConfig: { includeThoughts: true },
    });
  });

  test("when parallel calls carry IDs, groups their results in one turn with matching IDs", async () => {
    const tools: ModelRequest["tools"] = [
      { name: "read", namespace: null, description: "Read", parameters: { type: "object" } },
    ];

    const harness = fixture(undefined, () =>
      sse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "a", name: "read", args: { path: "one" } } },
                  { functionCall: { id: "b", name: "read", args: { path: "two" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ]),
    );

    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));
    const first = await Effect.runPromise(completeModel(model, { ...request, tools }));

    expect(first.finishReason).toBe("tool-calls");
    expect(first.output).toEqual([
      {
        type: "tool-call",
        callId: "a",
        name: "read",
        namespace: null,
        arguments: '{"path":"one"}',
      },
      {
        type: "tool-call",
        callId: "b",
        name: "read",
        namespace: null,
        arguments: '{"path":"two"}',
      },
    ]);

    await Effect.runPromise(
      completeModel(model, {
        ...request,
        tools,
        messages: [
          ...request.messages,
          { role: "assistant", output: first.output, continuation: first.continuation },
          { role: "tool", callId: "a", output: "1" },
          { role: "tool", callId: "b", output: "2" },
        ],
      }),
    );

    expect(harness.requests[1]?.body.contents).toMatchObject([
      { role: "user" },
      { role: "model" },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "a", name: "read", response: { output: "1" } } },
          { functionResponse: { id: "b", name: "read", response: { output: "2" } } },
        ],
      },
    ]);
  });

  test("when a user attaches images, sends supported types inline and rejects GIF before sending", async () => {
    const harness = fixture(undefined, () => sse([text("Seen", { finishReason: "STOP" })]));
    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));

    await Effect.runPromise(completeModel(model, withImage("image/png")));

    expect(harness.requests[0]?.body.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }],
      },
    ]);
    expect(await failureOf(completeModel(model, withImage("image/gif")))).toMatchObject({
      reason: "invalid-request",
      message: "Gemini accepts PNG, JPEG, and WebP images.",
    });
    expect(harness.requests).toHaveLength(1);
  });

  test("when settings or continuation are invalid, rejects them before sending", async () => {
    const harness = fixture([catalogEntry("gemini-test", { temperature: null })]);
    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));

    for (const invalid of [
      { ...request, settings: { temperature: 1 } },
      { ...request, settings: { maxOutputTokens: 65_537 } },
      continued({ protocol: "chat-completions" }),
      continued({ protocol: "generate-content", parts: [{ text: "Other" }], calls: [] }),
      continued({ protocol: "generate-content", parts: [{ text: "Hi" }], calls: [] }, "openrouter"),
    ]) {
      expect(await failureOf(completeModel(model, invalid))).toMatchObject({
        reason: "invalid-request",
      });
    }

    expect(harness.requests).toHaveLength(0);
  });

  test.each([
    ["no terminal response", [text("partial")], "The stream ended without successful completion."],
    [
      "the output limit",
      [text("partial", { finishReason: "MAX_TOKENS" })],
      "The model reached its output token limit before completing.",
    ],
    [
      "a safety stop",
      [text("partial", { finishReason: "SAFETY" })],
      "Gemini stopped the response before it completed.",
    ],
    [
      "an undeclared tool",
      [
        {
          candidates: [
            { content: { parts: [{ functionCall: { name: "other" } }] }, finishReason: "STOP" },
          ],
        },
      ],
      "The model returned an invalid tool call.",
    ],
    [
      "parts after the terminal response",
      [text("done", { finishReason: "STOP" }), text("more")],
      "The stream continued after its terminal response.",
    ],
  ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<Schema.JsonObject>, string]>)(
    "when the stream has %s, fails without completing",
    async (_label, events, message) => {
      const harness = fixture(undefined, () => sse(events));
      const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));

      expect(await failureOf(completeModel(model, request))).toMatchObject({
        provider: "gemini",
        reason: "interrupted",
        message,
      });
    },
  );

  test.each([
    [401, "UNAUTHENTICATED", "authentication", "secret-provider-details", []],
    [
      400,
      "INVALID_ARGUMENT",
      "authentication",
      "API key not valid. secret-provider-details",
      [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    ],
    [403, "PERMISSION_DENIED", "permission", "secret-provider-details", []],
    [
      429,
      "RESOURCE_EXHAUSTED",
      "rate-limit",
      "secret-provider-details",
      [quotaFailure("GenerateRequestsPerMinutePerProjectPerModel")],
    ],
    [
      429,
      "RESOURCE_EXHAUSTED",
      "quota",
      "secret-provider-details",
      [quotaFailure("GenerateRequestsPerDayPerProjectPerModel-FreeTier")],
    ],
    [
      400,
      "INVALID_ARGUMENT",
      "context-limit",
      "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).",
      [],
    ],
    [400, "INVALID_ARGUMENT", "invalid-request", "secret-provider-details", []],
    [500, "INTERNAL", "temporary", "secret-provider-details", []],
    [503, "UNAVAILABLE", "temporary", "secret-provider-details", []],
  ] as const)(
    "when inference fails with HTTP %i %s, classifies it as %s without retrying or exposing details",
    async (status, code, reason, message, details) => {
      const harness = fixture(undefined, () =>
        Response.json({ error: { code: status, status: code, message, details } }, { status }),
      );

      const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));
      const failure = await failureOf(completeModel(model, request));

      expect(failure).toMatchObject({ provider: "gemini", reason, status, code });
      expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
      expect(harness.requests).toHaveLength(1);
    },
  );

  test("when an error arrives mid-stream, classifies it after the partial output", async () => {
    const harness = fixture(undefined, () =>
      sse([
        text("partial"),
        { error: { code: 503, status: "UNAVAILABLE", message: "secret-provider-details" } },
      ]),
    );

    const model = await Effect.runPromise(harness.provider.resolve("gemini-test"));
    const failure = await failureOf(completeModel(model, request));

    expect(failure).toMatchObject({ reason: "temporary", code: "UNAVAILABLE" });
    expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
  });

  test("when the catalog rejects the key, reports an authentication failure", async () => {
    const provider = makeGeminiProvider(
      Effect.succeed(Redacted.make("bad-key")),
      async () =>
        Response.json(
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              details: [
                { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
              ],
            },
          },
          { status: 400 },
        ),
      baseUrl,
    );

    expect(await failureOf(provider.models)).toMatchObject({
      reason: "authentication",
      status: 400,
    });
  });

  test("when the consumer stops after a delta, aborts the request", async () => {
    const signals: Array<AbortSignal> = [];
    const http = stall(signals, Promise.withResolvers());
    const provider = makeGeminiProvider(Effect.succeed(Redacted.make("key")), http, baseUrl);
    const model = await Effect.runPromise(provider.resolve("gemini-test"));

    const events = await Effect.runPromise(
      model.stream(request).pipe(Stream.take(1), Stream.runCollect),
    );

    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("when the inference deadline expires, aborts the request using the Effect clock", async () => {
    const signals: Array<AbortSignal> = [];
    const reading = Promise.withResolvers<void>();

    const provider = makeGeminiProvider(
      Effect.succeed(Redacted.make("key")),
      stall(signals, reading),
      baseUrl,
    );

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* provider.resolve("gemini-test");

        const fiber = yield* completeModel(model, request).pipe(
          Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
          Effect.forkChild,
        );

        yield* Effect.promise(() => reading.promise);
        yield* TestClock.adjust("60 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(failure).toMatchObject({
      reason: "interrupted",
      message: "The inference deadline expired.",
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("when response headers do not arrive within 45 seconds, aborts the request", async () => {
    const signals: Array<AbortSignal> = [];
    const sent = Promise.withResolvers<void>();

    const provider = makeGeminiProvider(
      Effect.succeed(Redacted.make("key")),
      async (input, init) => {
        const incoming = new Request(input.toString(), init);

        if (new URL(incoming.url).pathname.endsWith("/models")) {
          return Response.json({ models: [catalogEntry("gemini-test")] });
        }

        signals.push(incoming.signal);
        sent.resolve();

        return new Promise<Response>((_resolve, reject) => {
          incoming.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
      baseUrl,
    );

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* provider.resolve("gemini-test");

        const fiber = yield* completeModel(model, request).pipe(
          Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
          Effect.forkChild,
        );

        yield* Effect.promise(() => sent.promise);
        yield* TestClock.adjust("45 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(failure).toMatchObject({
      reason: "interrupted",
      message: "The inference request timed out or was interrupted.",
    });
    expect(signals[0]?.aborted).toBe(true);
  });
});
