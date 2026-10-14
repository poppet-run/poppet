import { describe, expect, test } from "bun:test";

import {
  completeModel,
  verifyModel,
  type ModelDescription,
  type ModelRequest,
  type ProviderId,
} from "@poppet/provider";
import { Effect, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import OpenAI from "openai";

import { chatCompletionsModel } from "#src/chat-completions";
import { responsesModel } from "#src/responses";

type HttpFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

interface AdapterCase {
  readonly name: string;
  readonly provider: ProviderId;
  readonly protocol: "responses" | "chat-completions";
}

const cases: ReadonlyArray<AdapterCase> = [
  { name: "Responses", provider: "test-responses", protocol: "responses" },
  { name: "Chat Completions", provider: "test-chat", protocol: "chat-completions" },
];

const request: ModelRequest = {
  sessionId: "test-session",
  workload: "coding",
  instructions: "Test instructions",
  messages: [{ role: "user", text: "Hello" }],
  tools: [],
  settings: {},
};

const toolRequest: ModelRequest = {
  ...request,
  tools: [
    {
      name: "get_verification_token",
      namespace: "poppet_verification",
      description: "Test tool",
      parameters: {
        type: "object",
        properties: { challenge: { type: "string" } },
        required: ["challenge"],
        additionalProperties: false,
      },
    },
  ],
};

type Mode =
  | "trailing-usage"
  | "normal"
  | "text"
  | "truncated"
  | "malformed"
  | "bad-arguments"
  | "failed"
  | "incomplete"
  | "ordered"
  | "gap"
  | "missing-status"
  | "invalid-json"
  | "network-failure"
  | "stall";

const encode = (event: Schema.JsonObject) => `data: ${JSON.stringify(event)}\n\n`;

const fixture = (
  adapter: AdapterCase,
  mode: Mode = "normal",
  httpStatus = 200,
  errorCode = "request_failed",
) => {
  const requests: Schema.JsonObject[] = [];
  const headers: Headers[] = [];
  const signals: AbortSignal[] = [];
  const reading = Promise.withResolvers<void>();

  const http: HttpFetch = async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const body = Schema.decodeUnknownSync(Schema.JsonObject)(await incoming.json());
    requests.push(body);
    headers.push(incoming.headers);
    signals.push(incoming.signal);

    if (mode === "network-failure")
      throw new TypeError("Test network failure with secret-test-message");

    if (mode === "invalid-json")
      return new Response("data: {\n\n", { headers: { "Content-Type": "text/event-stream" } });

    if (httpStatus !== 200)
      return Response.json(
        {
          error: {
            code: errorCode,
            message: "Do not expose this secret-test-message",
          },
        },
        { status: httpStatus, headers: { "x-request-id": "req_test" } },
      );

    const serialized = JSON.stringify(body);
    const challenge = serialized.match(/challenge ([a-f0-9]+)/)?.[1] ?? "";
    const proof = serialized.match(/poppet_verified_[a-f0-9]+/)?.[0];
    const text = proof ?? "Hello world";
    const toolTurn = mode !== "text" && mode !== "stall" && proof === undefined;
    const args = mode === "bad-arguments" ? "{" : JSON.stringify({ challenge });
    const events: Schema.JsonObject[] = [];

    if (adapter.protocol === "responses") {
      const output: Schema.JsonObject[] = toolTurn
        ? [
            {
              type: "reasoning",
              id: "reason-1",
              summary: [],
              encrypted_content: "encrypted-test-reasoning",
            },
            {
              type: "function_call",
              id: "tool-1",
              call_id: "call-1",
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
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ];

      if (mode === "ordered") {
        output.splice(
          0,
          output.length,
          {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "first", annotations: [] }],
          },
          {
            type: "message",
            id: "msg-2",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "second", annotations: [] }],
          },
        );
      }

      if (mode === "missing-status" && output[1]) {
        const call = { ...output[1] };
        delete call.status;
        output[1] = call;
      }

      if (!toolTurn) events.push({ type: "response.output_text.delta", delta: "Hello " });

      for (const [output_index, item] of output.entries())
        events.unshift({
          type: "response.output_item.done",
          output_index: mode === "gap" ? output_index + 1 : output_index,
          item,
        });

      if (mode === "malformed")
        events.push({
          type: "response.completed",
          response: { status: "completed", output: [{ type: "message", content: null }] },
        });
      else if (mode === "failed")
        events.push({
          type: "response.failed",
          response: { error: { code: "insufficient_quota" } },
        });
      else if (mode === "incomplete")
        events.push({ type: "response.incomplete", response: { status: "incomplete" } });
      else if (mode !== "truncated" && mode !== "stall")
        events.push({
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        });
    } else {
      const delta =
        mode === "ordered"
          ? {
              tool_calls: [1, 0].map((index) => ({
                index,
                id: `call-${index + 1}`,
                type: "function",
                function: { name: "poppet_verification__get_verification_token", arguments: args },
              })),
            }
          : toolTurn
            ? {
                reasoning_content: "retained-test-reasoning",
                tool_calls: [
                  {
                    index: mode === "gap" ? 1 : 0,
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "poppet_verification__get_verification_token",
                      arguments: args.slice(0, 1),
                    },
                  },
                ],
              }
            : { content: text };

      events.push({ choices: [{ index: 0, delta, finish_reason: null }] });

      if (toolTurn && mode !== "ordered")
        events.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: mode === "gap" ? 1 : 0, function: { arguments: args.slice(1) } },
                ],
              },
              finish_reason: null,
            },
          ],
        });

      if (mode === "malformed")
        events.push({ choices: [{ index: 0, delta: { content: 42 }, finish_reason: "stop" }] });
      else if (mode === "failed")
        events.push({ error: { message: "Test failure", code: "insufficient_quota" } });
      else if (mode !== "truncated" && mode !== "stall")
        events.push({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: mode === "incomplete" ? "length" : toolTurn ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        });
    }

    if (mode === "trailing-usage")
      events.push({
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      });

    if (mode === "stall") {
      const first =
        adapter.protocol === "responses"
          ? { type: "response.output_text.delta", delta: "partial" }
          : { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] };

      const streamBody = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(encode(first)));
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

      return new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
    }

    return new Response(events.map(encode).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const description: ModelDescription = {
    provider: adapter.provider,
    id: "test-model",
    name: "Test model",
    capabilities: {
      tools: true,
      generationSettings: [],
      contextWindow: null,
      maxOutputTokens: null,
    },
  };

  const client = Effect.succeed(
    new OpenAI({
      apiKey: "test-secret",
      baseURL: "https://provider.invalid/v1",
      maxRetries: 0,
      logLevel: "off",
      fetch: http,
    }),
  );

  const model =
    adapter.protocol === "responses"
      ? responsesModel(description, client)
      : chatCompletionsModel(description, client);

  return { model, requests, headers, signals, reading: reading.promise };
};

for (const adapter of cases) {
  describe(adapter.name, () => {
    test("completes the shared tool exchange and preserves reasoning and session identity", async () => {
      const harness = fixture(adapter);
      await Effect.runPromise(verifyModel(harness.model));

      expect(harness.requests).toHaveLength(2);
      expect(harness.requests.every((body) => body.model === "test-model")).toBe(true);
      expect(
        harness.headers.every((header) => header.get("authorization") === "Bearer test-secret"),
      ).toBe(true);

      if (adapter.protocol === "responses")
        expect(JSON.stringify(harness.requests[1])).toContain("encrypted-test-reasoning");

      expect(harness.signals.every((signal) => signal.aborted)).toBe(true);
    });

    test("streams text and then returns authoritative output and usage", async () => {
      const harness = fixture(adapter, "text");
      const events = await Effect.runPromise(Stream.runCollect(harness.model.stream(request)));

      expect(events[0]?.type).toBe("text-delta");
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        response: {
          output: [{ type: "text", text: "Hello world" }],
          usage: { inputTokens: 11, outputTokens: 3 },
        },
      });
    });

    if (adapter.protocol === "chat-completions")
      test("rejects repeated terminal choices without an accounting-frame extension", async () => {
        const harness = fixture(adapter, "trailing-usage");
        await expect(
          Effect.runPromise(completeModel(harness.model, toolRequest)),
        ).rejects.toMatchObject({
          reason: "interrupted",
          message: "The model returned an invalid choice sequence.",
        });
        expect(harness.requests).toHaveLength(1);
      });

    test("preserves authoritative output or tool-call index order", async () => {
      const harness = fixture(adapter, "ordered");
      const completed = await Effect.runPromise(completeModel(harness.model, toolRequest));

      if (adapter.protocol === "responses")
        expect(completed.output).toEqual([
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ]);
      else expect(completed.output).toMatchObject([{ callId: "call-1" }, { callId: "call-2" }]);
    });

    test.each([
      "truncated",
      "malformed",
      "bad-arguments",
      "incomplete",
      "gap",
      "invalid-json",
    ] as const)("rejects %s output without completing", async (mode) => {
      const harness = fixture(adapter, mode);
      const events: string[] = [];

      await expect(
        Effect.runPromise(
          Stream.runForEach(harness.model.stream(toolRequest), (event) =>
            Effect.sync(() => events.push(event.type)),
          ),
        ),
      ).rejects.toMatchObject({ reason: "interrupted" });
      expect(events).not.toContain("completed");
      expect(harness.requests).toHaveLength(1);
    });

    test("classifies a failed stream and does not repeat inference", async () => {
      const harness = fixture(adapter, "failed");

      await expect(Effect.runPromise(completeModel(harness.model, request))).rejects.toMatchObject({
        reason: "quota",
      });
      expect(harness.requests).toHaveLength(1);
    });

    test("classifies network failure as temporary without retrying or exposing its details", async () => {
      const harness = fixture(adapter, "network-failure");

      const failure = await Effect.runPromise(
        completeModel(harness.model, request).pipe(
          Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
        ),
      );

      expect(failure).toMatchObject({ provider: adapter.provider, reason: "temporary" });
      expect(JSON.stringify(failure)).not.toContain("secret-test-message");
      expect(harness.requests).toHaveLength(1);
    });

    if (adapter.protocol === "responses")
      test("accepts completed function calls with the SDK's optional status omitted", async () => {
        const harness = fixture(adapter, "missing-status");
        await Effect.runPromise(verifyModel(harness.model));
        expect(harness.requests).toHaveLength(2);
      });

    test.each([
      ["401", 401, "request_failed", "authentication"],
      ["403", 403, "request_failed", "permission"],
      ["429 quota", 429, "insufficient_quota", "quota"],
      ["429 rate limit", 429, "rate_limit_exceeded", "rate-limit"],
      ["503", 503, "request_failed", "temporary"],
      ["context limit", 400, "context_length_exceeded", "context-limit"],
    ] as const)(
      "classifies HTTP %s safely and never retries",
      async (_label, status, errorCode, reason) => {
        const harness = fixture(adapter, "normal", status, errorCode);

        const failure = await Effect.runPromise(
          completeModel(harness.model, request).pipe(
            Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
          ),
        );

        expect(failure).toMatchObject({ reason, status, requestId: "req_test" });
        expect(JSON.stringify(failure)).not.toContain("secret-test-message");
        expect(harness.requests).toHaveLength(1);
      },
    );

    test("rejects unsupported settings and foreign continuation before making a request", async () => {
      const harness = fixture(adapter);

      await expect(
        Effect.runPromise(
          completeModel(harness.model, { ...request, settings: { temperature: 1 } }),
        ),
      ).rejects.toMatchObject({ reason: "invalid-request" });

      const continuations = [
        ["other-provider", "test-model", 1],
        [adapter.provider, "other-model", 1],
        [adapter.provider, "test-model", 2],
        [adapter.provider, "test-model", 1],
      ] as const;

      await Promise.all(
        continuations.map(async ([provider, model, version]) => {
          // SAFETY: deliberately inject version 2 as a version 1 request to verify
          // the runtime schema rejects malformed persisted data before any IO.
          const input = {
            role: "assistant" as const,
            output: [],
            continuation: { provider, model, version: version as 1, data: {} },
          };

          // Decode at the public boundary to exercise invalid persisted versions too.
          const invalid = { ...request, messages: [input] };
          await expect(
            Effect.runPromise(Stream.runCollect(harness.model.stream(invalid))),
          ).rejects.toMatchObject({ reason: "invalid-request" });
        }),
      );

      expect(harness.requests).toHaveLength(0);
    });

    test("aborts the request when the consumer stops after a delta", async () => {
      const harness = fixture(adapter, "stall");

      const events = await Effect.runPromise(
        harness.model.stream(request).pipe(Stream.take(1), Stream.runCollect),
      );

      expect(events).toHaveLength(1);
      expect(harness.signals[0]?.aborted).toBe(true);
    });

    test("aborts a pending network read on interruption", async () => {
      const harness = fixture(adapter, "stall");
      const fiber = Effect.runFork(Stream.runCollect(harness.model.stream(request)));
      await harness.reading;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(harness.signals[0]?.aborted).toBe(true);
    });

    test("enforces an absolute deadline using the Effect clock", async () => {
      const harness = fixture(adapter, "stall");

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* completeModel(harness.model, request).pipe(
            Effect.match({ onSuccess: () => null, onFailure: (failure) => failure }),
            Effect.forkChild,
          );

          yield* Effect.promise(() => harness.reading);
          yield* TestClock.adjust("60 seconds");

          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );

      expect(error).toMatchObject({
        reason: "interrupted",
        message: "The inference deadline expired.",
      });
      expect(harness.signals[0]?.aborted).toBe(true);
    });
  });
}
