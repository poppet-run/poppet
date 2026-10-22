import { describe, expect, test } from "bun:test";

import { Effect, Redacted } from "effect";

import { createHarness, login, verify } from "#src/test/fixtures/chatgpt";

describe.concurrent("ChatGPT sign-in", () => {
  test("reuses host and issued registration across restarts with fresh sign-in values", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      await harness.run(login);
      expect(harness.authorizations[0]?.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(harness.authorizations[1]?.searchParams.get("client_id")).toBe("oaiapp_test");
      expect(harness.authorizations[0]?.searchParams.get("prompt")).toBe("consent");
      expect(harness.authorizations[1]?.searchParams.has("prompt")).toBe(false);
      expect(harness.authorizations[1]?.searchParams.has("agent_name_hint")).toBe(false);
      expect(harness.authorizations[1]?.searchParams.get("ext_agent_host_id")).toBe(
        harness.authorizations[0]?.searchParams.get("ext_agent_host_id"),
      );
      expect(harness.authorizations[1]?.searchParams.get("state")).not.toBe(
        harness.authorizations[0]?.searchParams.get("state"),
      );
      expect(harness.authorizations[1]?.searchParams.get("nonce")).not.toBe(
        harness.authorizations[0]?.searchParams.get("nonce"),
      );
    } finally {
      await harness.close();
    }
  });
  test("retains a valid identity without plan permission and prevents inference", async () => {
    const harness = await createHarness();

    try {
      harness.controls.scopes = "openid email profile";
      expect(await harness.run(login)).toMatchObject({ connected: true, planUsage: false });
      await expect(harness.run(verify)).rejects.toMatchObject({ reason: "plan_disabled" });
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
  test("requests consent again when saved credentials lack plan permission", async () => {
    const harness = await createHarness();

    try {
      harness.controls.scopes = "openid email profile";
      await harness.run(login);
      harness.controls.scopes =
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
      expect(await harness.run(login)).toMatchObject({ connected: true, planUsage: true });
      expect(harness.authorizations[1]?.searchParams.get("client_id")).toBe("oaiapp_test");
      expect(harness.authorizations[1]?.searchParams.get("prompt")).toBe("consent");
    } finally {
      await harness.close();
    }
  });
  test.each(["invalid-url", "https://untrusted.invalid/authorize"])(
    "rejects discovery endpoint %s before opening the browser",
    async (endpoint) => {
      const harness = await createHarness();

      try {
        await harness.run(login);
        harness.controls.discoveryEndpoint = endpoint;
        await expect(harness.run(login)).rejects.toMatchObject({ reason: "identity" });
        expect(harness.authorizations).toHaveLength(1);
        expect(
          Redacted.value(
            (await harness.saved()).credentials?.accessToken ?? Redacted.make("missing"),
          ),
        ).toBe("test-access-1");
      } finally {
        await harness.close();
      }
    },
  );
  test.each(["audience", "nonce", "expiry", "signature", "future"] as const)(
    "rejects invalid identity %s without persisting credentials",
    async (failure) => {
      const harness = await createHarness();

      try {
        harness.controls.identityFailure = failure;
        await expect(harness.run(login)).rejects.toMatchObject({ reason: "identity" });
        expect((await harness.saved()).credentials).toBeNull();
      } finally {
        await harness.close();
      }
    },
  );
  test("ignores wrong callback state and rejects declined authorization without redeeming a code", async () => {
    const harness = await createHarness();

    try {
      // A callback for another attempt is refused but cannot end this one, which keeps waiting.
      harness.controls.wrongState = true;
      expect(
        await harness.run(
          login.pipe(
            Effect.as("completed"),
            Effect.timeoutOrElse({
              duration: "500 millis",
              orElse: () => Effect.succeed("waiting"),
            }),
          ),
        ),
      ).toBe("waiting");
      harness.controls.wrongState = false;
      harness.controls.denied = true;
      await expect(harness.run(login)).rejects.toMatchObject({ reason: "denied" });
      expect(harness.grants).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
  test("preserves the issued registration when code exchange fails", async () => {
    const harness = await createHarness();

    try {
      harness.controls.tokenError = "invalid_grant";
      await expect(harness.run(login)).rejects.toMatchObject({ reason: "reconnect" });
      expect((await harness.saved()).clientId).toBe("oaiapp_test");
      harness.controls.tokenError = null;
      await harness.run(login);
      expect(harness.authorizations[1]?.searchParams.get("client_id")).toBe("oaiapp_test");
    } finally {
      await harness.close();
    }
  });
  test("rejects account changes without replacing the existing token set", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      harness.controls.subject = "another-account";
      await expect(harness.run(login)).rejects.toMatchObject({ reason: "identity" });
      expect(
        Redacted.value(
          (await harness.saved()).credentials?.accessToken ?? Redacted.make("missing"),
        ),
      ).toBe("test-access-1");
    } finally {
      await harness.close();
    }
  });
});
