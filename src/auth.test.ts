import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Console, Effect, Layer, Match, Redacted, Schema } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { ChatGPTAuth, ChatGPTAuthLive } from "./auth.ts";
import { AppConfig } from "./config.ts";
import { Connection, ConnectionError, planScope } from "./connection.ts";
import { CredentialStore, CredentialStoreLive } from "./credentials.ts";
import { ChatGPTModel, makeChatGPTModel } from "./model.ts";
import { type HttpFetch, makeOAuthClient, OAuthClient } from "./oauth.ts";
import { BrowserSignIn, makeBrowserSignIn } from "./sign-in.ts";

const UserInput = Schema.Struct({ role: Schema.Literal("user"), content: Schema.String });

const CallInput = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
  arguments: Schema.String,
});

const ResultInput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String,
});

const ReasoningInput = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.optionalKey(Schema.String),
});

const ModelRequest = Schema.Struct({
  model: Schema.String,
  store: Schema.Boolean,
  stream: Schema.Boolean,
  tool_choice: Schema.String,
  tools: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String })),
  input: Schema.Array(Schema.Union([UserInput, CallInput, ResultInput, ReasoningInput])),
});

type StreamMode =
  | "completed"
  | "empty_terminal"
  | "truncated"
  | "failed"
  | "incomplete"
  | "wrong_tool"
  | "wrong_token";

interface Controls {
  scopes: string;
  subject: string;
  identityFailure: "none" | "audience" | "nonce" | "expiry" | "signature" | "future";
  wrongState: boolean;
  denied: boolean;
  discoveryEndpoint: string | null;
  tokenError: string | null;
  refreshError: string | null;
  streamMode: StreamMode;
  expireAccess: boolean;
  revokeFailure: boolean;
}

const localConsole: Console.Console = { ...console, log: () => undefined, error: () => undefined };

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-auth-test-"));
  const keys = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" };

  const controls: Controls = {
    scopes: `openid profile email offline_access resource.invoke ${planScope}`,
    subject: "test-account",
    identityFailure: "none",
    wrongState: false,
    denied: false,
    discoveryEndpoint: null,
    tokenError: null,
    refreshError: null,
    streamMode: "completed",
    expireAccess: false,
    revokeFailure: false,
  };

  const authorizations: URL[] = [];
  const grants: URLSearchParams[] = [];
  const requests: Array<typeof ModelRequest.Type> = [];
  const bearerHeaders: Array<string | null> = [];
  let nonce = "";
  let tokenCount = 0;
  let revokedToken: string | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, listener) => {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${listener.port}`;

      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: origin,
          authorization_endpoint: controls.discoveryEndpoint ?? `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          revocation_endpoint: `${origin}/revoke`,
          jwks_uri: `${origin}/jwks`,
        });

      if (url.pathname === "/jwks") return Response.json({ keys: [publicKey] });

      if (url.pathname === "/authorize") {
        authorizations.push(url);
        nonce = url.searchParams.get("nonce") ?? "";
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set(
          "state",
          controls.wrongState ? "wrong-state" : (url.searchParams.get("state") ?? ""),
        );
        callback.searchParams.set("client_id", "oaiapp_test");

        if (controls.denied) callback.searchParams.set("error", "access_denied");
        else callback.searchParams.set("code", "test-code");

        return Response.redirect(callback.toString());
      }

      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        grants.push(body);
        const refresh = body.get("grant_type") === "refresh_token";
        const error = refresh ? controls.refreshError : controls.tokenError;

        if (error !== null)
          return Response.json({ error }, { status: error === "temporary_error" ? 503 : 400 });

        if (!refresh) {
          const attempt = authorizations.at(-1);
          expect(
            createHash("sha256")
              .update(body.get("code_verifier") ?? "")
              .digest("base64url"),
          ).toBe(attempt?.searchParams.get("code_challenge") ?? "");
          expect(body.get("redirect_uri")).toBe(attempt?.searchParams.get("redirect_uri") ?? null);
        }

        tokenCount++;

        let idToken = await new SignJWT({
          sub: controls.subject,
          email: "test@example.com",
          nonce: controls.identityFailure === "nonce" ? "incorrect" : nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(origin)
          .setAudience(controls.identityFailure === "audience" ? "another-client" : "oaiapp_test")
          .setIssuedAt(
            controls.identityFailure === "future" ? Math.floor(Date.now() / 1000) + 60 : undefined,
          )
          .setExpirationTime(controls.identityFailure === "expiry" ? "-1 minute" : "1 hour")
          .sign(keys.privateKey);

        if (controls.identityFailure === "signature")
          idToken = `${idToken.slice(0, idToken.lastIndexOf(".") + 1)}invalid`;

        return Response.json({
          access_token: `test-access-${tokenCount}`,
          refresh_token: `test-refresh-${tokenCount}`,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: controls.expireAccess && !refresh ? 10 : 3600,
          scope: controls.scopes,
        });
      }

      if (url.pathname === "/revoke") {
        revokedToken = new URLSearchParams(await request.text()).get("token");

        return new Response(null, { status: controls.revokeFailure ? 503 : 200 });
      }

      bearerHeaders.push(request.headers.get("authorization"));

      if (url.pathname === "/v1/models")
        return Response.json({
          models: [
            { slug: "test-model", display_name: "Test model", visibility: "list" },
            { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
          ],
        });

      if (url.pathname !== "/v1/responses") return new Response(null, { status: 404 });

      const body = Schema.decodeUnknownSync(ModelRequest)(await request.json());
      requests.push(body);

      const result = body.input.find(
        (item) => "type" in item && item.type === "function_call_output",
      );

      const user = body.input.find((item) => "role" in item && item.role === "user");

      const challenge =
        user && "content" in user ? (user.content.match(/challenge ([a-f0-9]+)/)?.[1] ?? "") : "";

      const proof = result
        ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ token: Schema.String })))(
            result.output,
          ).token
        : "";

      const output = result
        ? [
            {
              type: "message",
              id: "msg-1",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: controls.streamMode === "wrong_token" ? "incorrect" : proof,
                  annotations: [],
                },
              ],
            },
          ]
        : [
            {
              type: "reasoning",
              id: "reason-1",
              summary: [],
              encrypted_content: "test-reasoning-state",
            },
            {
              type: "function_call",
              id: "call-1",
              call_id: "call-1",
              name: "get_verification_token",
              namespace:
                controls.streamMode === "wrong_tool" ? "other_namespace" : "poppet_verification",
              arguments: JSON.stringify({ challenge }),
              status: "completed",
            },
          ];

      const event = Match.value(controls.streamMode).pipe(
        Match.when("failed", () => ({
          type: "response.failed",
          response: {
            id: "response-1",
            status: "failed",
            output: [],
            error: { code: "subscription_sharing_usage_limit_exceeded" },
          },
        })),
        Match.when("incomplete", () => ({
          type: "response.incomplete",
          response: { id: "response-1", status: "incomplete", output: [], error: null },
        })),
        Match.orElse(() => ({
          type: "response.completed",
          response: {
            id: "response-1",
            status: "completed",
            output: controls.streamMode === "empty_terminal" ? [] : output,
            error: null,
          },
        })),
      );

      const itemEvents = ["empty_terminal", "truncated", "failed", "incomplete"].includes(
        controls.streamMode,
      )
        ? output.map((item, output_index) => ({
            type: "response.output_item.done",
            output_index,
            item,
          }))
        : [];

      const events = [
        ...itemEvents.toReversed(),
        ...(controls.streamMode === "truncated" ? [] : [event]),
      ];

      const stream = `${events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;

      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const http: HttpFetch = (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const url = new URL(request.url);

    if (url.origin === "https://api.openai.com")
      return fetch(new Request(new URL(url.pathname, server.url).toString(), request));

    return fetch(request);
  };

  const browser = makeBrowserSignIn((url) =>
    Effect.tryPromise({
      try: (signal) => fetch(url, { signal }).then(() => undefined),
      catch: () => new ConnectionError({ reason: "callback", message: "Test browser failed." }),
    }),
  );

  const config = Layer.succeed(AppConfig, {
    applicationName: "Poppet",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
  });

  const dependencies = Layer.mergeAll(
    config,
    Layer.effect(OAuthClient, makeOAuthClient(http, server.url.origin)),
    Layer.succeed(BrowserSignIn, browser),
  );

  const storage = CredentialStoreLive.pipe(Layer.provideMerge(dependencies));
  const auth = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));
  const runtime = Layer.effect(ChatGPTModel, makeChatGPTModel(http)).pipe(Layer.provideMerge(auth));

  const run = <A>(
    program: Effect.Effect<A, ConnectionError, ChatGPTAuth | ChatGPTModel | CredentialStore>,
  ) =>
    Effect.runPromise(
      program.pipe(Effect.provide(runtime), Effect.provideService(Console.Console, localConsole)),
    );

  const saved = async () =>
    Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
      await readFile(join(directory, "auth/connection.json"), "utf8"),
    );

  return {
    directory,
    controls,
    authorizations,
    grants,
    requests,
    bearerHeaders,
    run,
    saved,
    revoked: () => revokedToken,
    close: async () => {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const login = Effect.gen(function* () {
  const auth = yield* ChatGPTAuth;

  return yield* auth.login(false);
});

const status = Effect.gen(function* () {
  const auth = yield* ChatGPTAuth;

  return yield* auth.status;
});

const verify = Effect.gen(function* () {
  const model = yield* ChatGPTModel;

  return yield* model.verify(null);
});

describe("ChatGPT connection", () => {
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

  test("reuses host and issued registration across restarts with fresh sign-in values", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      await harness.run(login);
      expect(harness.authorizations[0]?.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(harness.authorizations[1]?.searchParams.get("client_id")).toBe("oaiapp_test");
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

  test("rejects wrong callback state and declined authorization without redeeming a code", async () => {
    const harness = await createHarness();

    try {
      harness.controls.wrongState = true;
      await expect(harness.run(login)).rejects.toMatchObject({ reason: "callback" });
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

  test("rejects malformed stored credentials and competing owners", async () => {
    const harness = await createHarness();

    try {
      await harness.run(status);
      const path = join(harness.directory, "auth/connection.json");
      await writeFile(path, "invalid-json");
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readFile(path, "utf8")).toBe("invalid-json");
      await writeFile(join(harness.directory, "auth/owner.lock"), "another owner");
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "busy" });
    } finally {
      await harness.close();
    }
  });

  test("rejects credential symlinks without reading or changing their targets", async () => {
    const harness = await createHarness();

    try {
      await harness.run(status);
      const path = join(harness.directory, "auth/connection.json");
      const target = join(harness.directory, "unrelated-file");
      await writeFile(target, "keep this file");
      await unlink(path);
      await symlink(target, path);
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readFile(target, "utf8")).toBe("keep this file");
      await unlink(target);
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
    } finally {
      await harness.close();
    }
  });
});
