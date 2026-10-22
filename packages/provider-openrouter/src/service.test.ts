import { describe, expect, test } from "bun:test";

import { completeModel, verifyModel, type ModelRequest } from "@poppet/provider";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeOpenRouterProvider, type HttpFetch } from "#src/service";

const request: ModelRequest = {
  sessionId: "router-session",
  workload: "assistant",
  instructions: "Test",
  messages: [{ role: "user", text: "Hello" }],
  tools: [],
  settings: {},
};

const catalogEntry = (
  id: string,
  parameters = ["tools", "tool_choice", "temperature", "max_tokens"],
  outputs = ["text"],
  tokenizer = "GPT",
) => ({
  id,
  name: id,
  context_length: 10000,
  architecture: { input_modalities: ["text", "image"], output_modalities: outputs, tokenizer },
  supported_parameters: parameters,
  top_provider: { max_completion_tokens: 2000 },
});

const details = [
  {
    type: "reasoning.text",
    text: "First ",
    signature: null,
    id: "r-1",
    format: "anthropic-claude-v1",
    index: 0,
  },
  {
    type: "reasoning.text",
    text: "second",
    signature: "signed",
    id: "r-1",
    format: "anthropic-claude-v1",
    index: 0,
    extra: { preserve: true },
  },
  {
    type: "reasoning.summary",
    summary: "summary",
    id: null,
    format: "openai-responses-v1",
    index: 1,
  },
  { type: "reasoning.encrypted", data: "opaque", id: "r-2", format: "google-gemini-v1", index: 2 },
];

const sse = (events: ReadonlyArray<Schema.JsonObject>) =>
  new Response(
    ": keepalive\n\n" +
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );

const toolResponse = (body: Schema.JsonObject) => {
  const json = JSON.stringify(body);
  const proof = json.match(/poppet_verified_[a-f0-9]+/)?.[0];

  if (proof)
    return sse([
      { choices: [{ index: 0, delta: { content: proof }, finish_reason: "stop" }] },
      {
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      },
    ]);

  const args = JSON.stringify({ challenge: json.match(/challenge ([a-f0-9]+)/)?.[1] ?? "" });

  return sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning: "First second",
            reasoning_details: details.slice(0, 1),
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "poppet_verification__get_verification_token",
                  arguments: args.slice(0, 5),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_details: details.slice(1),
            tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ]);
};

const fixture = (
  catalog: ReadonlyArray<Schema.JsonObject> = [catalogEntry("vendor/model")],
  respond: (body: Schema.JsonObject) => Response = toolResponse,
) => {
  const requests: Array<{ path: string; headers: Headers; body: Schema.JsonObject }> = [];
  let keyReads = 0;

  const http: HttpFetch = async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const path = new URL(incoming.url).pathname;

    if (path.endsWith("/models")) {
      expect(incoming.headers.get("authorization")).toBeNull();

      return Response.json({ data: catalog });
    }

    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await incoming.json());
    requests.push({ path, body, headers: incoming.headers });

    return respond(body);
  };

  const key = Effect.sync(() => {
    keyReads++;

    return Redacted.make("router-test-secret");
  });

  return {
    provider: makeOpenRouterProvider(key, http, "https://router.invalid/api/v1"),
    requests,
    keyReads: () => keyReads,
  };
};

describe("OpenRouter", () => {
  test("aborts a stalled catalog body when discovery times out", async () => {
    const reading = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];

    const http: HttpFetch = async (input, init) => {
      const incoming =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

      signals.push(incoming.signal);

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{"data":['));
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

    const provider = makeOpenRouterProvider(Effect.die("Key must not be read"), http);

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
      message: "OpenRouter model discovery timed out.",
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("discovers concrete text models and their catalog capabilities without credentials", async () => {
    const harness = fixture([
      catalogEntry("vendor/model"),
      catalogEntry("vendor/text-only", ["max_completion_tokens"]),
      catalogEntry("openrouter/auto", [], ["text"], "Router"),
      catalogEntry("openrouter/free", [], ["text"], "Router"),
      catalogEntry("vendor/router", [], ["text"], "Router"),
      catalogEntry("~vendor/latest"),
      catalogEntry("vendor/image", [], ["image"]),
      catalogEntry("vendor/multimodal-output", [], ["text", "image"]),
    ]);

    const models = await Effect.runPromise(harness.provider.models);

    expect(models.map((model) => [model.id, model.capabilities])).toEqual([
      [
        "vendor/model",
        {
          tools: true,
          generationSettings: ["temperature", "maxOutputTokens"],
          contextWindow: 10000,
          maxOutputTokens: 2000,
        },
      ],
      [
        "vendor/text-only",
        {
          tools: false,
          generationSettings: ["maxOutputTokens"],
          contextWindow: 10000,
          maxOutputTokens: 2000,
        },
      ],
    ]);

    await Promise.all(
      ["openrouter/auto", "vendor/router", "absent/model"].map((id) =>
        expect(Effect.runPromise(harness.provider.resolve(id))).rejects.toMatchObject({
          reason: "invalid-request",
        }),
      ),
    );
    expect(harness.keyReads()).toBe(0);
    expect(harness.requests).toHaveLength(0);
  });

  test.each([false, true])(
    "streams readable reasoning once, excluding encrypted details, when enabled=%s",
    async (enabled) => {
      const harness = fixture(undefined, () =>
        sse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  reasoning: "First ",
                  reasoning_content: "First ",
                  reasoning_details: details.slice(0, 1),
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              { index: 0, delta: { reasoning_details: details.slice(1) }, finish_reason: null },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { reasoning: " fallback", content: "Answer" },
                finish_reason: "stop",
              },
            ],
          },
        ]),
      );

      const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));

      const events = await Effect.runPromise(
        Stream.runCollect(model.stream({ ...request, settings: { reasoningSummary: enabled } })),
      );

      expect(
        events
          .filter((event) => event.type === "reasoning-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe(enabled ? "First secondsummary fallback" : "");
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        response: {
          output: [{ type: "text", text: "Answer" }],
          continuation: { data: { reasoningDetails: details } },
        },
      });
    },
  );

  test("preserves the complete reasoning sequence through a tool round trip and keeps routing explicit", async () => {
    const harness = fixture();
    const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));
    expect(harness.keyReads()).toBe(0);
    await Effect.runPromise(verifyModel(model));

    expect(harness.requests).toHaveLength(2);

    for (const outgoing of harness.requests) {
      expect(outgoing.path).toBe("/api/v1/chat/completions");
      expect(outgoing.body).toMatchObject({
        model: "vendor/model",
        provider: { require_parameters: true, allow_fallbacks: false },
      });
      expect(outgoing.body.models).toBeUndefined();
      expect(outgoing.headers.get("authorization")).toBe("Bearer router-test-secret");
      expect(outgoing.headers.get("user-agent")).toBe("poppet/0.0.0");
      expect(outgoing.headers.get("http-referer")).toBe("https://poppet.run");
      expect(outgoing.headers.get("x-openrouter-title")).toBe("Poppet");
      expect(outgoing.headers.get("x-opencode-session")).toBeNull();
    }

    expect(harness.requests[1]?.body.session_id).toBe(harness.requests[0]?.body.session_id);

    const messages = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
      harness.requests[1]?.body.messages,
    );

    expect(messages.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_details: details,
    });
    expect(JSON.stringify(harness.requests.map((outgoing) => outgoing.body))).not.toContain(
      "router-test-secret",
    );
  });

  test.each([
    ["empty choices", []],
    ["empty delta", [{ index: 0, delta: {}, finish_reason: "stop" }]],
    [
      "empty content",
      [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
    ],
  ] satisfies ReadonlyArray<readonly [string, ReadonlyArray<Schema.JsonObject>]>)(
    "accepts final accounting with %s without duplicating output and retains its usage",
    async (_label, choices) => {
      const harness = fixture(undefined, () =>
        sse([
          { choices: [{ index: 0, delta: { content: "Complete" }, finish_reason: "stop" }] },
          { choices, usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]),
      );

      const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));
      const events = await Effect.runPromise(Stream.runCollect(model.stream(request)));
      expect(events).toEqual([
        { type: "text-delta", text: "Complete" },
        {
          type: "completed",
          response: expect.objectContaining({
            output: [{ type: "text", text: "Complete" }],
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        },
      ]);
      expect(harness.requests).toHaveLength(1);
    },
  );

  test("rejects another accounting choice after accepting the final usage frame", async () => {
    const accounting = {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const harness = fixture(undefined, () =>
      sse([
        { choices: [{ index: 0, delta: { content: "Complete" }, finish_reason: "stop" }] },
        accounting,
        accounting,
      ]),
    );

    const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));
    const events: string[] = [];
    await expect(
      Effect.runPromise(
        Stream.runForEach(model.stream(request), (event) =>
          Effect.sync(() => events.push(event.type)),
        ),
      ),
    ).rejects.toMatchObject({ reason: "interrupted" });
    expect(events).not.toContain("completed");
    expect(harness.requests).toHaveLength(1);
  });

  test.each([
    ["text", { choices: [{ index: 0, delta: { content: "unexpected" }, finish_reason: "stop" }] }],
    [
      "tool call",
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
            finish_reason: "stop",
          },
        ],
      },
    ],
    [
      "reasoning",
      { choices: [{ index: 0, delta: { reasoning_details: details }, finish_reason: "stop" }] },
    ],
    ["changed finish", { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
    ["changed index", { choices: [{ index: 1, delta: {}, finish_reason: "stop" }] }],
    [
      "multiple choices",
      {
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "stop" },
        ],
      },
    ],
    ["missing usage", { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null }],
  ] satisfies ReadonlyArray<readonly [string, Schema.JsonObject]>)(
    "rejects %s in a frame after the terminal choice without completing",
    async (_label, frame) => {
      const harness = fixture(undefined, () =>
        sse([
          { choices: [{ index: 0, delta: { content: "Complete" }, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 10, completion_tokens: 5 }, ...frame },
        ]),
      );

      const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));
      const events: string[] = [];
      await expect(
        Effect.runPromise(
          Stream.runForEach(model.stream(request), (event) =>
            Effect.sync(() => events.push(event.type)),
          ),
        ),
      ).rejects.toMatchObject({ reason: "interrupted" });
      expect(events).not.toContain("completed");
      expect(harness.requests).toHaveLength(1);
    },
  );

  test.each(["max_tokens", "max_completion_tokens"])(
    "supports assistant text with %s and omits unused tool fields",
    async (parameter) => {
      const harness = fixture([catalogEntry("vendor/text-only", [parameter, "temperature"])], () =>
        sse([{ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] }]),
      );

      const model = await Effect.runPromise(harness.provider.resolve("vendor/text-only"));

      const response = await Effect.runPromise(
        completeModel(model, { ...request, settings: { temperature: 0.5, maxOutputTokens: 100 } }),
      );

      expect(response.output).toEqual([{ type: "text", text: "Hello" }]);
      expect(harness.requests[0]?.body).toMatchObject({
        [parameter]: 100,
        temperature: 0.5,
        session_id: "router-session",
      });
      expect(harness.requests[0]?.body.tools).toBeUndefined();
      expect(harness.requests[0]?.body.tool_choice).toBeUndefined();
    },
  );

  test("rejects unsupported tools, settings, output bounds and malformed continuation before reading a key", async () => {
    const harness = fixture([catalogEntry("vendor/text-only", ["max_tokens"])]);
    const model = await Effect.runPromise(harness.provider.resolve("vendor/text-only"));

    await expect(Effect.runPromise(verifyModel(model))).rejects.toMatchObject({
      reason: "invalid-request",
    });
    await expect(
      Effect.runPromise(completeModel(model, { ...request, settings: { temperature: 1 } })),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    await expect(
      Effect.runPromise(completeModel(model, { ...request, settings: { maxOutputTokens: 2001 } })),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    await expect(
      Effect.runPromise(
        completeModel(model, {
          ...request,
          messages: [
            {
              role: "assistant",
              output: [],
              continuation: {
                version: 1,
                provider: "openrouter",
                model: "vendor/text-only",
                data: {
                  protocol: "chat-completions",
                  reasoningContent: null,
                  reasoningDetails: [{ type: "reasoning.text", text: 42 }],
                },
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    expect(harness.keyReads()).toBe(0);
    expect(harness.requests).toHaveLength(0);
  });

  test.each([
    [402, "quota"],
    [401, "authentication"],
    [429, "rate-limit"],
    [503, "temporary"],
    ["server_error", "temporary"],
  ] as const)(
    "classifies an HTTP 200 stream error %s safely without retrying",
    async (code, reason) => {
      const harness = fixture(undefined, () =>
        sse([
          { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
          {
            error: { code, message: "secret-provider-details" },
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
          },
        ]),
      );

      const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));

      const failure = await Effect.runPromise(
        completeModel(model, request).pipe(
          Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
        ),
      );

      expect(failure).toMatchObject({ provider: "openrouter", reason });
      expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
      expect(harness.requests).toHaveLength(1);
    },
  );

  test("reports insufficient credits before streaming without exposing server details", async () => {
    const harness = fixture(undefined, () =>
      Response.json({ error: { code: 402, message: "secret-provider-details" } }, { status: 402 }),
    );

    const model = await Effect.runPromise(harness.provider.resolve("vendor/model"));

    const failure = await Effect.runPromise(
      completeModel(model, request).pipe(
        Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
      ),
    );

    expect(failure).toMatchObject({ reason: "quota", status: 402 });
    expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
    expect(harness.requests).toHaveLength(1);
  });

  test.each([
    [() => Response.json({ data: [{ id: "secret-provider-details" }] }), "unsupported"],
    [() => new Response("secret-provider-details"), "invalid"],
  ] as const)(
    "reports malformed catalogs without exposing response details",
    async (response, kind) => {
      const provider = makeOpenRouterProvider(Effect.die("Key must not be read"), async () =>
        response(),
      );

      const failure = await Effect.runPromise(provider.models.pipe(Effect.flip));

      expect(failure).toMatchObject({
        provider: "openrouter",
        reason: "invalid-request",
        message: `OpenRouter returned an ${kind} model catalog.`,
      });
      expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
    },
  );

  test.each([
    [401, "authentication"],
    [402, "quota"],
    [503, "temporary"],
  ] as const)("reports catalog HTTP %i and releases its response body", async (status, reason) => {
    let cancelled = false;

    const provider = makeOpenRouterProvider(
      Effect.die("Key must not be read"),
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("secret-provider-details"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        ),
    );

    const failure = await Effect.runPromise(provider.models.pipe(Effect.flip));

    expect(failure).toMatchObject({ provider: "openrouter", status, reason });
    expect(JSON.stringify(failure)).not.toContain("secret-provider-details");
    expect(cancelled).toBe(true);
  });
});
