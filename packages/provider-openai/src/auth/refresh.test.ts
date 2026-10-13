import { describe, expect, test } from "bun:test";

import { Effect, Redacted } from "effect";

import { ChatGPTAuth } from "#src/auth/service";
import { createHarness, login, status, verify } from "#src/test/fixtures/chatgpt";

describe("ChatGPT token lifecycle", () => {
  test("serializes renewal and atomically retains the rotated refresh token", async () => {
    const harness = await createHarness();

    try {
      harness.controls.expireAccess = true;
      await harness.run(login);

      const tokens = await harness.run(
        Effect.gen(function* () {
          const auth = yield* ChatGPTAuth;

          return yield* Effect.all([auth.accessToken, auth.accessToken], {
            concurrency: "unbounded",
          });
        }),
      );

      expect(tokens.map(Redacted.value)).toEqual(["test-access-2", "test-access-2"]);
      expect(
        harness.grants.filter((grant) => grant.get("grant_type") === "refresh_token"),
      ).toHaveLength(1);
      expect(
        Redacted.value(
          (await harness.saved()).credentials?.refreshToken ?? Redacted.make("missing"),
        ),
      ).toBe("test-refresh-2");
    } finally {
      await harness.close();
    }
  });
  test("preserves tokens on temporary refresh failure and clears terminally unusable tokens", async () => {
    const harness = await createHarness();

    try {
      harness.controls.expireAccess = true;
      await harness.run(login);
      harness.controls.refreshError = "temporary_error";
      await expect(harness.run(verify)).rejects.toMatchObject({ reason: "temporary" });
      expect((await harness.saved()).credentials).not.toBeNull();
      harness.controls.refreshError = "invalid_grant";
      await expect(harness.run(verify)).rejects.toMatchObject({ reason: "reconnect" });
      expect((await harness.saved()).credentials).toBeNull();
      expect((await harness.saved()).clientId).toBe("oaiapp_test");
    } finally {
      await harness.close();
    }
  });
  test("clears tokens on sign-out even when revocation fails, keeping registration", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      harness.controls.revokeFailure = true;

      const revoked = await harness.run(
        Effect.gen(function* () {
          const auth = yield* ChatGPTAuth;

          return yield* auth.signOut;
        }),
      );

      expect(revoked).toBe(false);
      expect(harness.revoked()).toBe("test-refresh-1");
      expect(await harness.run(status)).toMatchObject({
        connected: false,
        clientId: "oaiapp_test",
        planUsage: false,
      });
      expect((await harness.saved()).credentials).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
