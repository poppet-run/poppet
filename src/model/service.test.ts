import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { ConnectionError } from "../connection.ts";
import { createHarness, login, status, verify } from "../test/fixtures/chatgpt.ts";

describe("ChatGPT model verification", () => {
  test("retains completed streamed items in output order when the terminal response omits them", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      harness.controls.streamMode = "empty_terminal";
      expect(await harness.run(verify)).toBe("test-model");
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
        await expect(harness.run(verify)).rejects.toBeInstanceOf(ConnectionError);
        expect((await harness.saved()).verification).toBeNull();

        if (mode === "failed")
          await expect(harness.run(verify)).rejects.toMatchObject({
            reason: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
          });
      } finally {
        await harness.close();
      }
    },
  );
});
