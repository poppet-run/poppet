import { describe, expect, test } from "bun:test";

import { completeModel, verifyModel } from "@poppet/provider";
import type { ModelRequest, ProviderId } from "@poppet/provider";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeOpenCodeProvider } from "#src/service";
import type { HttpFetch } from "#src/service";

const request: ModelRequest = {
  sessionId: "go-session",
  instructions: "Test",
  messages: [{ role: "user", text: "Hello" }],
  tools: [],
  settings: {},
};

interface FixtureModel {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly recommended_api?: string;
  readonly api?: Record<string, { readonly base_url: string }>;
  readonly modalities?: {
    readonly input: ReadonlyArray<string>;
    readonly output: ReadonlyArray<string>;
  };
  readonly capabilities?: {
    readonly tools?: { readonly supported?: boolean };
    readonly temperature?: boolean;
  };
  readonly limit?: {
    readonly context?: number | null;
    readonly output?: number | null;
  };
  readonly cost?: {
    readonly text?: {
      readonly input?: { readonly price?: number };
      readonly output?: { readonly price?: number };
    };
  };
  readonly go?: {
    readonly monthly_usage?: Record<string, number> | null;
  };
}

const defaultCatalog: ReadonlyArray<FixtureModel> = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    type: "chat",
    recommended_api: "responses",
    api: { responses: { base_url: "https://opencode.ai/inference/go/openai/v1" } },
    modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: true },
    limit: { context: 1_050_000, output: 128_000 },
    cost: { text: { input: { price: 0.75 }, output: { price: 4.5 } } },
    go: { monthly_usage: { go: 15, "go-plus": 60, "go-teams": 20 } },
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    type: "chat",
    recommended_api: "chat-completions",
    api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: true },
    limit: { context: 1_000_000, output: 131_072 },
    cost: { text: { input: { price: 1.4 }, output: { price: 4.4 } } },
    go: { monthly_usage: { go: 200, "go-plus": 400, "go-teams": 205 } },
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    type: "chat",
    recommended_api: "messages",
    api: { messages: { base_url: "https://opencode.ai/inference/go/anthropic/v1" } },
    modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: false },
    limit: { context: 1_000_000, output: 128_000 },
    cost: { text: { input: { price: 1 }, output: { price: 5 } } },
    go: { monthly_usage: { go: 15, "go-plus": 60, "go-teams": 20 } },
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    type: "chat",
    recommended_api: "interactions",
    api: { interactions: { base_url: "https://opencode.ai/inference/go/google/v1beta" } },
    modalities: { input: ["text", "image/webp"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: false },
    limit: { context: 1_048_576, output: 65_536 },
    cost: { text: { input: { price: 0.5 }, output: { price: 3 } } },
    go: { monthly_usage: { go: 30, "go-plus": 120, "go-teams": 35 } },
  },
  {
    id: "beam-free",
    name: "Beam Free",
    type: "chat",
    recommended_api: "chat-completions",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: true },
    limit: { context: 1_048_576, output: 131_072 },
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    go: { monthly_usage: null },
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    type: "chat",
    recommended_api: "chat-completions",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { tools: { supported: true }, temperature: true },
    limit: { context: 200_000, output: 32_000 },
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
  },
  {
    id: "jev-1.14",
    name: "Jev 1.14",
    type: "decision",
    recommended_api: "systemone",
    modalities: { input: ["text"], output: ["decision"] },
    capabilities: { tools: { supported: false }, temperature: false },
    limit: { context: 64_000 },
    go: { monthly_usage: { go: 10, "go-plus": 40, "go-teams": 15 } },
  },
  {
    id: "text-embedding-3-small",
    name: "text-embedding-3-small",
    type: "embedding",
    recommended_api: "embeddings",
    modalities: { input: ["text"], output: ["embedding"] },
    capabilities: { tools: { supported: false }, temperature: false },
    limit: { context: 8192, output: 0 },
    go: { monthly_usage: { go: 10, "go-plus": 40, "go-teams": 15 } },
  },
];

const fixture = (options?: {
  readonly id?: ProviderId;
  readonly label?: string;
  readonly baseUrl?: string;
  readonly catalog?: (authorization: string | null) => ReadonlyArray<FixtureModel>;
  readonly token?: () => string | null;
}) => {
  const requests: Array<{ path: string; headers: Headers; body: Schema.JsonObject }> = [];
  const catalogAuthHeaders: Array<string | null> = [];
  let keyReads = 0;
  let catalogReads = 0;

  const catalogFor = options?.catalog ?? (() => defaultCatalog);
  const readToken = options?.token ?? (() => "go-test-secret");

  const http: HttpFetch = async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const path = new URL(incoming.url).pathname;

    if (path.endsWith("/models")) {
      catalogReads++;
      expect(incoming.headers.get("user-agent")).toBe("poppet/0.0.0");
      const authorization = incoming.headers.get("authorization");
      catalogAuthHeaders.push(authorization);
      const entries = catalogFor(authorization);

      return Response.json({
        object: "list",
        data: entries.map((entry) => ({ object: "model", ...entry })),
      });
    }

    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await incoming.json());
    requests.push({ path, body, headers: incoming.headers });
    const json = JSON.stringify(body);
    const proof = json.match(/poppet_verified_[a-f0-9]+/)?.[0];
    const args = JSON.stringify({ challenge: json.match(/challenge ([a-f0-9]+)/)?.[1] ?? "" });
    const toolTurn = proof === undefined;

    const response = path.endsWith("/responses")
      ? {
          type: "response.completed",
          response: {
            status: "completed",
            output: toolTurn
              ? [
                  {
                    type: "reasoning",
                    id: "reason-1",
                    summary: [],
                    encrypted_content: "go-reasoning",
                  },
                  {
                    type: "function_call",
                    call_id: "call-1",
                    id: "tool-1",
                    name: "get_verification_token",
                    namespace: "poppet_verification",
                    arguments: args,
                    status: "completed",
                  },
                ]
              : [
                  {
                    type: "message",
                    id: "msg-1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: proof, annotations: [] }],
                  },
                ],
          },
        }
      : {
          choices: [
            {
              index: 0,
              delta: toolTurn
                ? {
                    reasoning_content: "go-reasoning",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "poppet_verification__get_verification_token",
                          arguments: args,
                        },
                      },
                    ],
                  }
                : { content: proof },
              finish_reason: toolTurn ? "tool_calls" : "stop",
            },
          ],
        };

    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const key = Effect.sync(() => {
    keyReads++;

    return Redacted.make(readToken() ?? "go-test-secret");
  });

  const optionalKey = Effect.sync(() => {
    const token = readToken();

    return token === null ? null : Redacted.make(token);
  });

  const provider = makeOpenCodeProvider(key, {
    id: options?.id ?? "opencode-go",
    label: options?.label ?? "OpenCode Go",
    baseUrl: options?.baseUrl ?? "https://go.invalid/v1",
    http,
    optionalKey,
  });

  return {
    provider,
    requests,
    catalogAuthHeaders,
    keyReads: () => keyReads,
    catalogReads: () => catalogReads,
  };
};

describe("makeOpenCodeProvider", () => {
  test("when catalog discovery times out, aborts its stalled body", async () => {
    const reading = Promise.withResolvers<void>();
    const signals: Array<AbortSignal> = [];

    const provider = makeOpenCodeProvider(Effect.die("Key must not be read"), {
      http: async (_input, init) => {
        const signal = init?.signal;

        if (!signal) {
          throw new Error("Missing request cancellation");
        }

        signals.push(signal);

        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(new Error("Aborted")), {
                once: true,
              });
            },
            pull() {
              reading.resolve();
            },
          }),
        );
      },
      optionalKey: Effect.succeed(null),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* provider.models.pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => reading.promise);
        yield* TestClock.adjust("30 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(result).toHaveProperty("failure.reason", "temporary");
    expect(signals[0]?.aborted).toBe(true);
  });

  test.each([false, true])(
    "when reasoning_content is enabled=%j, streams only permitted reasoning",
    async (enabled) => {
      const harness = fixture();
      const model = await Effect.runPromise(harness.provider.resolve("glm-5.3"));

      const events = await Effect.runPromise(
        Stream.runCollect(
          model.stream({
            ...request,
            settings: { reasoningSummary: enabled },
            tools: [
              {
                name: "get_verification_token",
                namespace: "poppet_verification",
                description: "Test tool",
                parameters: { type: "object" },
              },
            ],
          }),
        ),
      );

      expect(events.filter((event) => event.type === "reasoning-delta")).toEqual(
        enabled ? [{ type: "reasoning-delta", text: "go-reasoning" }] : [],
      );
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        response: {
          continuation: { data: { reasoningContent: "go-reasoning" } },
        },
      });
    },
  );

  test("when discovering models without credentials, returns public paid chat models with capabilities", async () => {
    const harness = fixture({ token: () => null });
    const models = await Effect.runPromise(harness.provider.models);

    expect(harness.catalogAuthHeaders).toEqual([null]);
    expect(models).toEqual([
      {
        provider: "opencode-go",
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["temperature", "maxOutputTokens"],
          contextWindow: 1_050_000,
          maxOutputTokens: 128_000,
        },
      },
      {
        provider: "opencode-go",
        id: "glm-5.3",
        name: "GLM-5.3",
        capabilities: {
          tools: true,
          images: false,
          generationSettings: ["temperature", "maxOutputTokens"],
          contextWindow: 1_000_000,
          maxOutputTokens: 131_072,
        },
      },
      {
        provider: "opencode-go",
        id: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["maxOutputTokens"],
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
        },
      },
      {
        provider: "opencode-go",
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["maxOutputTokens"],
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
        },
      },
    ]);
    expect(models.every((model) => !("protocol" in model))).toBe(true);
    expect(harness.keyReads()).toBe(0);
  });

  test("when configured for pay-as-you-go OpenCode, uses the opencode provider ID and filters free-tier models by price", async () => {
    const paygCatalog: ReadonlyArray<FixtureModel> = [
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        type: "chat",
        recommended_api: "messages",
        modalities: { input: ["text", "image/png"], output: ["text"] },
        capabilities: { tools: { supported: true }, temperature: false },
        limit: { context: 1_000_000, output: 128_000 },
        cost: { text: { input: { price: 2 }, output: { price: 10 } } },
      },
      {
        id: "big-pickle",
        name: "Big Pickle",
        type: "chat",
        recommended_api: "chat-completions",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { tools: { supported: true }, temperature: true },
        limit: { context: 200_000, output: 32_000 },
        cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      },
    ];

    const harness = fixture({
      id: "opencode",
      label: "OpenCode",
      baseUrl: "https://opencode.invalid/inference/openai/v1",
      catalog: (authorization) =>
        authorization === "Bearer oc-payg-secret" ? paygCatalog : defaultCatalog,
      token: () => "oc-payg-secret",
    });

    const models = await Effect.runPromise(harness.provider.models);

    expect(harness.catalogAuthHeaders).toEqual(["Bearer oc-payg-secret"]);
    expect(models).toEqual([
      {
        provider: "opencode",
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        capabilities: {
          tools: true,
          images: true,
          generationSettings: ["maxOutputTokens"],
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
        },
      },
    ]);

    const resolved = await Effect.runPromise(harness.provider.resolve("claude-sonnet-5-5"));
    await Effect.runPromise(verifyModel(resolved));
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests.every((item) => item.path.endsWith("/chat/completions"))).toBe(true);
    expect(
      harness.requests.every(
        (item) => item.headers.get("authorization") === "Bearer oc-payg-secret",
      ),
    ).toBe(true);
  });

  test("when credentials are configured or change, authenticates catalog discovery and isolates cached catalogs per key", async () => {
    let activeToken: string | null = null;

    const catalogsByAuth = new Map<string, ReadonlyArray<FixtureModel>>([
      ["Bearer workspace-a", defaultCatalog.filter((entry) => entry.id === "glm-5.3")],
      ["Bearer workspace-b", defaultCatalog.filter((entry) => entry.id === "claude-haiku-5-5")],
    ]);

    const harness = fixture({
      token: () => activeToken,
      catalog: (authorization) =>
        authorization === null
          ? defaultCatalog
          : (catalogsByAuth.get(authorization) ?? defaultCatalog),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const publicModel = yield* harness.provider.resolve("gpt-6-luna");
        expect(publicModel.description.id).toBe("gpt-6-luna");

        activeToken = "workspace-a";
        const workspaceAModels = yield* harness.provider.models;
        expect(workspaceAModels.map((model) => model.id)).toEqual(["glm-5.3"]);

        const workspaceAModel = yield* harness.provider.resolve("glm-5.3");
        expect(workspaceAModel.description.id).toBe("glm-5.3");
        expect(harness.catalogReads()).toBe(2);

        activeToken = "workspace-b";
        const workspaceBModel = yield* harness.provider.resolve("claude-haiku-5-5");
        expect(workspaceBModel.description.id).toBe("claude-haiku-5-5");
        expect(harness.catalogReads()).toBe(3);

        const rejected = yield* harness.provider.resolve("glm-5.3").pipe(Effect.result);
        expect(rejected).toHaveProperty("failure.reason", "invalid-request");
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(harness.catalogAuthHeaders).toEqual([
      null,
      "Bearer workspace-a",
      "Bearer workspace-b",
      "Bearer workspace-b",
    ]);
  });

  test.each([
    { modelId: "gpt-6-luna", endpoint: "/responses" },
    { modelId: "glm-5.3", endpoint: "/chat/completions" },
    { modelId: "claude-haiku-5-5", endpoint: "/chat/completions" },
    { modelId: "gemini-4-argon", endpoint: "/chat/completions" },
  ])(
    "when $modelId is resolved, completes the tool exchange on $endpoint",
    async ({ modelId, endpoint }) => {
      const harness = fixture();
      const model = await Effect.runPromise(harness.provider.resolve(modelId));
      expect(harness.keyReads()).toBe(0);
      await Effect.runPromise(verifyModel(model));

      expect(harness.requests).toHaveLength(2);
      expect(harness.requests.every((item) => item.path.endsWith(endpoint))).toBe(true);
      expect(harness.requests.every((item) => item.body.model === modelId)).toBe(true);
      expect(
        harness.requests.every(
          (item) =>
            item.headers.get("user-agent") === "poppet/0.0.0" &&
            item.headers.get("authorization") === "Bearer go-test-secret",
        ),
      ).toBe(true);
      expect(harness.requests[1]?.headers.get("x-opencode-session")).toBe(
        harness.requests[0]?.headers.get("x-opencode-session"),
      );
      expect(JSON.stringify(harness.requests[1]?.body)).toContain("go-reasoning");
      expect(JSON.stringify(harness.requests.map((item) => item.body))).not.toContain(
        "go-test-secret",
      );
      expect(harness.keyReads()).toBe(2);
    },
  );

  test("when settings are unsupported, rejects them before reading inference credentials", async () => {
    const harness = fixture();
    const model = await Effect.runPromise(harness.provider.resolve("claude-haiku-5-5"));

    await expect(
      Effect.runPromise(completeModel(model, { ...request, settings: { temperature: 1 } })),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    expect(harness.keyReads()).toBe(0);
    expect(harness.requests).toHaveLength(0);
  });

  test("when a model is free-tier, non-chat, or absent from the catalog, rejects it without selecting an alternative", async () => {
    const harness = fixture({
      catalog: () => defaultCatalog.filter((entry) => entry.id !== "gpt-6-luna"),
    });

    for (const modelId of [
      "beam-free",
      "big-pickle",
      "jev-1.14",
      "text-embedding-3-small",
      "gpt-6-luna",
    ]) {
      await expect(Effect.runPromise(harness.provider.resolve(modelId))).rejects.toMatchObject({
        reason: "invalid-request",
      });
    }

    expect(harness.requests).toHaveLength(0);
  });

  test("when the remote catalog has no decodable entries, fails with invalid-request", async () => {
    const provider = makeOpenCodeProvider(Effect.die("Key must not be read"), {
      baseUrl: "https://go.invalid/v1",
      http: async () => Response.json({ object: "list", data: [{ id: "glm-5.3" }] }),
      optionalKey: Effect.succeed(null),
    });

    await expect(Effect.runPromise(provider.models)).rejects.toMatchObject({
      reason: "invalid-request",
    });
  });

  test("when resolving models repeatedly, caches catalog lookups for 60 seconds and refreshes on expiry or explicit listing", async () => {
    const harness = fixture();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all(
          [harness.provider.resolve("glm-5.3"), harness.provider.resolve("glm-5.3")],
          { concurrency: 2 },
        );
        expect(harness.catalogReads()).toBe(1);

        yield* TestClock.adjust("59999 millis");
        yield* harness.provider.resolve("gpt-6-luna");
        expect(harness.catalogReads()).toBe(1);

        yield* TestClock.adjust("1 millis");
        yield* harness.provider.resolve("glm-5.3");
        expect(harness.catalogReads()).toBe(2);

        yield* harness.provider.models;
        expect(harness.catalogReads()).toBe(3);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
