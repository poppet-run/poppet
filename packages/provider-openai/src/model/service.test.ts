import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { completeModel } from "@poppet/provider";
import { Effect, Redacted } from "effect";

import { ChatGPTAuth } from "#src/auth/service";
import { ConnectionError } from "#src/connection";
import { makeChatGPTModel, makeChatGPTProvider } from "#src/model/service";
import type { HttpFetch } from "#src/oauth/http";
import { createHarness, login, status, verify } from "#src/test/fixtures/chatgpt";

describe("ChatGPT model verification", () => {
  test("retains completed streamed items in output order when the terminal response omits them", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      harness.controls.streamMode = "empty_terminal";
      expect(await harness.run(verify)).toBe("test-model");
      expect(harness.catalogReads()).toBe(1);
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[1]?.input.slice(1, 3)).toMatchObject([
        { type: "reasoning", id: "reason-1", encrypted_content: "test-reasoning-state" },
        { type: "function_call", call_id: "call-1", namespace: "poppet_verification" },
      ]);
      expect((await harness.saved()).verification?.model).toBe("test-model");
    } finally {
      await harness.close();
    }
  });
  test("signs in, stores protected credentials, and verifies a complete namespaced tool round trip", async () => {
    const harness = await createHarness();

    try {
      expect((await harness.run(login)).planUsage).toBe(true);
      expect(await harness.run(verify)).toBe("test-model");
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests.every((request) => !request.store && request.stream)).toBe(true);
      expect(harness.requests[0]?.tools[0]?.type).toBe("namespace");
      expect(
        harness.requests[1]?.input.some((item) => "type" in item && item.type === "reasoning"),
      ).toBe(true);
      expect(
        harness.requests[1]?.input.some(
          (item) =>
            "type" in item && item.type === "function_call_output" && item.call_id === "call-1",
        ),
      ).toBe(true);
      expect(harness.bearerHeaders.every((value) => value === "Bearer test-access-1")).toBe(true);
      expect((await harness.saved()).verification?.model).toBe("test-model");
      expect((await stat(join(harness.directory, "auth"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(harness.directory, "auth/connection.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect(await Bun.file(join(harness.directory, "auth/owner.lock")).exists()).toBe(false);
      expect(JSON.stringify(await harness.run(status))).not.toContain("test-access");
    } finally {
      await harness.close();
    }
  });
  test.each(["truncated", "failed", "incomplete", "wrong_tool", "wrong_token"] as const)(
    "does not record verification for %s model responses",
    async (mode) => {
      const harness = await createHarness();

      try {
        await harness.run(login);
        harness.controls.streamMode = mode;

        const failure = await harness.run(
          verify.pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
        );

        expect(failure).toBeInstanceOf(ConnectionError);
        expect((await harness.saved()).verification).toBeNull();

        if (mode === "failed")
          expect(failure).toMatchObject({
            reason: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
          });
      } finally {
        await harness.close();
      }
    },
  );
});

describe("ChatGPT provider inference", () => {
  test.each([
    ["subscription_sharing_invalid_user", "authentication"],
    ["subscription_sharing_user_not_eligible", "permission"],
    ["subscription_sharing_usage_limit_exceeded", "quota"],
    ["subscription_sharing_usage_unavailable", "temporary"],
  ] as const)(
    "classifies %s through the shared model interface without retrying or exposing server details",
    async (code, reason) => {
      let inferenceRequests = 0;

      const http: HttpFetch = async (input) => {
        const url = input instanceof Request ? input.url : input.toString();

        if (url.endsWith("/models"))
          return Response.json({
            models: [{ slug: "test-model", display_name: "Test model", visibility: "list" }],
          });
        inferenceRequests++;

        return Response.json(
          { error: { code, message: "secret-server-message" } },
          { status: 400, headers: { "x-request-id": "req_subscription" } },
        );
      };

      const auth: ChatGPTAuth["Service"] = {
        accessToken: Effect.succeed(Redacted.make("test-token")),
        login: () => Effect.die("Login must not run."),
        status: Effect.die("Status must not run."),
        signOut: Effect.die("Sign-out must not run."),
        recordVerification: () => Effect.die("Verification must not be recorded."),
      };

      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = makeChatGPTProvider(yield* makeChatGPTModel(http));
          const model = yield* provider.resolve("test-model");

          return yield* completeModel(model, {
            sessionId: "subscription-test",
            workload: "assistant",
            instructions: "",
            messages: [{ role: "user", text: "Test" }],
            tools: [],
            settings: {},
          }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));
        }).pipe(Effect.provideService(ChatGPTAuth, auth)),
      );

      expect(failure).toMatchObject({
        provider: "openai-chatgpt",
        reason,
        code,
        status: 400,
        requestId: "req_subscription",
      });
      expect(JSON.stringify(failure)).not.toContain("secret-server-message");
      expect(inferenceRequests).toBe(1);
    },
  );
});
