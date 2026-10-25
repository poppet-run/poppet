import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { ChatGPTAuth } from "#src/auth/service";
import { createHarness, login, status, verify } from "#src/test/fixtures/chatgpt";

describe.concurrent("refresh.ts", () => {
  test("when renewals run concurrently, serializes them and atomically saves the rotated refresh token", async () => {
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

      const grants = harness.grants.filter((grant) => grant.get("grant_type") === "refresh_token");

      expect(tokens.map(Redacted.value)).toEqual(["test-access-2", "test-access-2"]);
      expect(grants).toHaveLength(1);
      expect(grants[0]?.get("refresh_token")).toBe("test-refresh-1");
      expect(
        Redacted.value(
          (await harness.saved()).credentials?.refreshToken ?? Redacted.make("missing"),
        ),
      ).toBe("test-refresh-2");
    } finally {
      await harness.close();
    }
  });
  test("when renewal omits refresh credentials or scopes, preserves their saved values", async () => {
    const harness = await createHarness();

    try {
      harness.controls.expireAccess = true;
      await harness.run(login);
      const before = (await harness.saved()).credentials!;
      harness.controls.omitRefreshFields = true;

      const token = await harness.run(ChatGPTAuth.use((auth) => auth.accessToken));
      const after = (await harness.saved()).credentials!;

      expect(Redacted.value(token)).toBe("test-access-2");
      expect(after.accessToken && Redacted.value(after.accessToken)).toBe(Redacted.value(token));
      expect(after.refreshToken && Redacted.value(after.refreshToken)).toBe(
        before.refreshToken && Redacted.value(before.refreshToken),
      );
      expect(Redacted.value(after.idToken)).toBe(Redacted.value(before.idToken));
      expect(after.scopes).toEqual(before.scopes);
    } finally {
      await harness.close();
    }
  });
  test("when renewed tokens belong to another account, rejects them without replacing saved credentials", async () => {
    const harness = await createHarness();

    try {
      harness.controls.expireAccess = true;
      await harness.run(login);
      const path = join(harness.directory, "auth/connection.json");
      const before = await readFile(path, "utf8");
      harness.controls.subject = "another-account";

      await expect(harness.run(verify)).rejects.toMatchObject({ reason: "identity" });
      expect(await readFile(path, "utf8")).toBe(before);
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
  test("when refresh fails, preserves temporarily usable tokens and clears terminally unusable ones", async () => {
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
  test.each([false, true])(
    "when sign-out has revocation failure=%j, deletes local provider details and starts a fresh registration",
    async (revokeFailure) => {
      const harness = await createHarness();

      try {
        await harness.run(login);
        await harness.run(verify);
        const before = await harness.saved();
        const unrelated = join(harness.directory, "auth/other-provider.json");
        await writeFile(unrelated, "other-provider-details");
        harness.controls.revokeFailure = revokeFailure;

        const revoked = await harness.run(
          Effect.gen(function* () {
            const auth = yield* ChatGPTAuth;

            return yield* auth.signOut;
          }),
        );

        expect(revoked).toBe(!revokeFailure);
        expect(harness.revoked()).toBe("test-refresh-1");
        expect(await harness.run(status)).toMatchObject({
          connected: false,
          email: null,
          clientId: null,
          planUsage: false,
          expiresAt: null,
          verification: null,
        });
        const connectionFile = Bun.file(join(harness.directory, "auth/connection.json"));
        expect(await connectionFile.exists()).toBe(false);
        expect(await readFile(unrelated, "utf8")).toBe("other-provider-details");
        await expect(harness.run(verify)).rejects.toMatchObject({ reason: "reconnect" });
        expect(await connectionFile.exists()).toBe(false);
        await harness.run(login);
        expect((await harness.saved()).hostId).not.toBe(before.hostId);
        expect(harness.authorizations.at(-1)?.searchParams.get("client_id")).toBe(
          "dynamic_agent_client",
        );
      } finally {
        await harness.close();
      }
    },
  );
});
