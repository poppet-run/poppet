import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Console, Effect, Layer, Schema } from "effect";

import { CredentialStore, CredentialStoreLive } from "../../auth/credentials.ts";
import { ChatGPTAuth, ChatGPTAuthLive } from "../../auth/service.ts";
import { Connection, ConnectionError } from "../../connection.ts";
import { ChatGPTModel, makeChatGPTModel } from "../../model/service.ts";
import { makeOAuthClient, OAuthClient } from "../../oauth/client.ts";
import type { HttpFetch } from "../../oauth/http.ts";
import { BrowserSignIn, makeBrowserSignIn } from "../../sign-in/service.ts";
import { createControls } from "./controls.ts";
import { makeOAuthProvider } from "./oauth.ts";
import { makeResponsesProvider } from "./responses.ts";

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
