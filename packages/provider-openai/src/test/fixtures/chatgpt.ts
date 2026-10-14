import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderEnvironment } from "@poppet/provider";
import { Console, Effect, Layer, Schema } from "effect";

import { CredentialStore, CredentialStoreLive } from "#src/auth/credentials";
import { ChatGPTAuth, ChatGPTAuthLive } from "#src/auth/service";
import { Connection, ConnectionError } from "#src/connection";
import { ChatGPTModel, makeChatGPTModel } from "#src/model/service";
import { makeOAuthClient, OAuthClient } from "#src/oauth/client";
import type { HttpFetch } from "#src/oauth/http";
import { BrowserSignIn, makeBrowserSignIn } from "#src/sign-in/service";
import { createControls } from "#src/test/fixtures/controls";
import { makeOAuthProvider } from "#src/test/fixtures/oauth";
import { makeResponsesProvider } from "#src/test/fixtures/responses";

const localConsole: Console.Console = { ...console, log: () => undefined, error: () => undefined };

export const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-auth-test-"));
  const controls = createControls();
  const oauth = await makeOAuthProvider(controls);
  const responses = makeResponsesProvider(controls);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, listener) =>
      (await oauth.handle(request, `http://127.0.0.1:${listener.port}`)) ??
      responses.handle(request),
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

  const config = Layer.succeed(ProviderEnvironment, {
    applicationName: "Poppet",
    dataDirectory: directory,
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
    authorizations: oauth.authorizations,
    grants: oauth.grants,
    requests: responses.requests,
    bearerHeaders: responses.bearerHeaders,
    run,
    saved,
    revoked: oauth.revoked,
    close: async () => {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

export const login = Effect.gen(function* () {
  const auth = yield* ChatGPTAuth;

  return yield* auth.login(false);
});

export const status = Effect.gen(function* () {
  const auth = yield* ChatGPTAuth;

  return yield* auth.status;
});

export const verify = Effect.gen(function* () {
  const model = yield* ChatGPTModel;

  return yield* model.verify(null);
});
