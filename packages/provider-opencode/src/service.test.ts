import { describe, expect, test } from "bun:test";

import { completeModel, verifyModel, type ModelRequest } from "@poppet/provider";
import { Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeOpenCodeProvider, type HttpFetch } from "#src/service";

const request: ModelRequest = {
  sessionId: "go-session",
  workload: "coding",
  instructions: "Test",
  messages: [{ role: "user", text: "Hello" }],
  tools: [],
  settings: {},
};

const fixture = (catalogIds = ["gpt-6-luna", "glm-5.3", "minimax-m3"]) => {
  const requests: Array<{ path: string; headers: Headers; body: Schema.JsonObject }> = [];
  let keyReads = 0;
  let catalogReads = 0;

  const http: HttpFetch = async (input, init) => {
    const incoming =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const path = new URL(incoming.url).pathname;

    if (path.endsWith("/models")) {
      catalogReads++;
      expect(incoming.headers.get("user-agent")).toBe("poppet/0.0.0");
      expect(incoming.headers.get("authorization")).toBeNull();

      return Response.json({
        object: "list",
        data: catalogIds.map((id) => ({ id, object: "model" })),
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

    return Redacted.make("go-test-secret");
  });

  const provider = makeOpenCodeProvider(key, http, "https://go.invalid/v1");

  return { provider, requests, keyReads: () => keyReads, catalogReads: () => catalogReads };
};

describe("OpenCode Go", () => {
  test("aborts a stalled catalog body when discovery times out", async () => {
    const reading = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];

    const provider = makeOpenCodeProvider(
      Effect.die("Key must not be read"),
      async (_input, init) => {
        const signal = init?.signal;

        if (!signal) throw new Error("Missing request cancellation");
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
    );

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

  test.each([false, true])("streams reasoning_content only when enabled=%s", async (enabled) => {
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
  });

  test("discovers only the tested model/protocol set without reading a key", async () => {
    const harness = fixture();
    const models = await Effect.runPromise(harness.provider.models);

    expect(models.map((model) => model.id)).toEqual(["gpt-6-luna", "glm-5.3"]);
    expect(models.every((model) => !("protocol" in model))).toBe(true);
    expect(harness.keyReads()).toBe(0);
  });

  test.each(["gpt-6-luna", "glm-5.3"])(
    "resolves %s and completes a shared tool exchange on its documented endpoint",
    async (modelId) => {
      const harness = fixture();
      const model = await Effect.runPromise(harness.provider.resolve(modelId));
      expect(harness.keyReads()).toBe(0);
      await Effect.runPromise(verifyModel(model));

      expect(harness.requests).toHaveLength(2);
      expect(
        harness.requests.every((item) =>
          item.path.endsWith(modelId === "gpt-6-luna" ? "/responses" : "/chat/completions"),
        ),
      ).toBe(true);
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

  test("rejects general assistant workloads and unsupported settings before reading credentials", async () => {
    const harness = fixture();
    const model = await Effect.runPromise(harness.provider.resolve("gpt-6-luna"));

    await expect(
      Effect.runPromise(completeModel(model, { ...request, workload: "assistant" })),
    ).rejects.toMatchObject({ reason: "permission" });
    await expect(
      Effect.runPromise(completeModel(model, { ...request, settings: { temperature: 1 } })),
    ).rejects.toMatchObject({ reason: "invalid-request" });
    expect(harness.keyReads()).toBe(0);
    expect(harness.requests).toHaveLength(0);
  });

  test("rejects unsupported or removed models without selecting an alternative", async () => {
    const harness = fixture(["glm-5.3"]);

    await expect(Effect.runPromise(harness.provider.resolve("minimax-m3"))).rejects.toMatchObject({
      reason: "invalid-request",
    });
    expect(harness.catalogReads()).toBe(0);
    await expect(Effect.runPromise(harness.provider.resolve("gpt-6-luna"))).rejects.toMatchObject({
      reason: "invalid-request",
    });
    expect(harness.requests).toHaveLength(0);
  });
});
