import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { auth, extractWWWAuthenticateParams, OAuthError } from "@modelcontextprotocol/client";
import type {
  AuthOptions,
  FetchLike,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import { makeRecordStore, RecordStoreError } from "@poppet/credentials/records";
import { ProviderEnvironment } from "@poppet/provider";
import { authorizeInBrowser, startCallback } from "@poppet/sign-in";
import type { BrowserOptions, SignInError } from "@poppet/sign-in";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { Types } from "effect";

import type { MCPHTTPServer, MCPOAuth } from "#src/config";
import { BlockedOAuthEndpoint, oauthAddress, oauthFetch } from "#src/oauth-network";

export class MCPLoginRequired extends Data.TaggedError("MCPLoginRequired")<{
  readonly message: string;
}> {}

export class MCPSignInError extends Data.TaggedError("MCPSignInError")<{
  readonly message: string;
}> {}

export type MCPOAuthServer = MCPHTTPServer & { readonly oauth: MCPOAuth };

export const isOAuthServer = (server: MCPHTTPServer): server is MCPOAuthServer =>
  server.oauth !== undefined;

const SavedSignIn = Schema.Struct({
  url: Schema.String,
  client: Schema.optionalKey(Schema.JsonObject),
  tokens: Schema.optionalKey(Schema.JsonObject),
  tokensSavedAt: Schema.optionalKey(Schema.Number),
  discovery: Schema.optionalKey(Schema.JsonObject),
  refreshLease: Schema.optionalKey(Schema.Struct({ id: Schema.String, expiresAt: Schema.Number })),
});

type SavedSignIn = typeof SavedSignIn.Type;

type Working = Types.Mutable<SavedSignIn>;

const recordName = (id: string) => `mcp-oauth-${id}`;

const login = (id: string) => `Run poppet mcp login ${id}.`;

const required = (id: string, reason: string) =>
  new MCPLoginRequired({ message: `MCP ${id}: ${reason} ${login(id)}` });

const decode = (id: string, value: Schema.Json | null) =>
  value === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(SavedSignIn, { onExcessProperty: "error" })(value).pipe(
        Effect.mapError(
          () =>
            new RecordStoreError({
              message: `Cannot read Poppet's protected sign-in for MCP ${id}.`,
            }),
        ),
      );

export class MCPSignIns extends Context.Service<
  MCPSignIns,
  {
    readonly read: (id: string) => Effect.Effect<SavedSignIn | null, RecordStoreError>;
    readonly update: <E>(
      id: string,
      change: (current: SavedSignIn | null) => Effect.Effect<SavedSignIn | null, E>,
    ) => Effect.Effect<void, E | RecordStoreError>;
  }
>()("poppet/MCPSignIns") {}

export const MCPSignInsLive = Layer.effect(
  MCPSignIns,
  Effect.gen(function* () {
    const { dataDirectory } = yield* ProviderEnvironment;
    const records = makeRecordStore(dataDirectory);

    return {
      read: (id) => records.read(recordName(id)).pipe(Effect.flatMap((value) => decode(id, value))),
      update: (id, change) =>
        records
          .update(recordName(id), (current) =>
            decode(id, current).pipe(
              Effect.flatMap(change),
              Effect.map((next) => (next === null ? null : Schema.encodeSync(SavedSignIn)(next))),
            ),
          )
          .pipe(Effect.asVoid),
    };
  }),
);

const resourceMetadata = (config: MCPOAuthServer, advertised: URL | undefined) => {
  const explicit = config.oauth.resourceMetadataUrl;

  if (explicit !== undefined) {
    return new URL(explicit);
  }

  if (advertised !== undefined && advertised.origin !== new URL(config.url).origin) {
    throw new MCPSignInError({
      message: `MCP ${config.id}: the OAuth resource metadata must use the MCP server origin.`,
    });
  }

  return advertised;
};

const JSONObject = Schema.fromJsonString(Schema.JsonObject);

const json = <A extends object>(value: A) =>
  Schema.decodeUnknownSync(JSONObject)(JSON.stringify(value));

const copy = (saved: SavedSignIn | null, url: string): Working =>
  saved === null || saved.url !== url ? { url } : { ...saved };

const AccessToken = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});

const accessToken = (record: Working | SavedSignIn | null) =>
  record?.tokens === undefined
    ? null
    : Option.getOrNull(Schema.decodeUnknownOption(AccessToken)(record.tokens));

const tokenForServer = (saved: SavedSignIn | null, config: MCPOAuthServer) =>
  saved?.url === config.url ? accessToken(saved) : null;

const RedirectURIs = Schema.Struct({ redirect_uris: Schema.Array(Schema.String) });

const registeredRedirect = (record: Working) =>
  record.client === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(RedirectURIs)(record.client))
        ?.redirect_uris[0];

const Stamped = Schema.Struct({ client_id: Schema.String, issuer: Schema.String });

interface Session {
  verifier?: string;
}

interface ProviderOptions {
  readonly redirectUri: string;
  readonly state?: string;
  readonly secret: string | undefined;
  readonly allowRegistration?: boolean;
  readonly redirect: (url: URL) => void;
  readonly now: () => number;
}

const makeProvider = (
  config: MCPOAuthServer,
  record: Working,
  session: Session,
  options: ProviderOptions,
): OAuthClientProvider => {
  const configured = config.oauth.clientId;

  const provider: OAuthClientProvider = {
    redirectUrl: options.redirectUri,
    clientMetadata: {
      client_name: "Poppet",
      redirect_uris: [options.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.secret === undefined ? "none" : "client_secret_basic",
    },
    clientInformation: () => {
      if (configured === undefined) {
        // SAFETY: saveClientInformation stores only SDK-validated registrations.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return record.client as StoredOAuthClientInformation | undefined;
      }

      const information: StoredOAuthClientInformation = { client_id: configured };
      const saved = Option.getOrUndefined(Schema.decodeUnknownOption(Stamped)(record.client));
      const issuer = saved?.client_id === configured ? saved.issuer : undefined;

      if (options.secret !== undefined) {
        information.client_secret = options.secret;
      }

      if (issuer !== undefined) {
        information.issuer = issuer;
      }

      return information;
    },
    ...(options.allowRegistration !== false && {
      saveClientInformation: (information: StoredOAuthClientInformation) => {
        record.client =
          configured === undefined
            ? json(information)
            : json({ client_id: configured, issuer: information.issuer });
      },
    }),
    // SAFETY: saveTokens stores only SDK-validated token responses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    tokens: () => record.tokens as StoredOAuthTokens | undefined,
    saveTokens: (tokens) => {
      record.tokens = json(tokens);
      record.tokensSavedAt = options.now();
    },
    redirectToAuthorization: options.redirect,
    saveCodeVerifier: (verifier) => {
      session.verifier = verifier;
    },
    codeVerifier: () => {
      if (session.verifier === undefined) {
        throw new Error("No sign-in is in progress.");
      }

      return session.verifier;
    },
    saveDiscoveryState: (state) => {
      record.discovery = json(state);
    },
    // SAFETY: saveDiscoveryState stores only SDK-validated discovery results.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    discoveryState: () => record.discovery as OAuthDiscoveryState | undefined,
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") {
        delete record.client;
      }

      if (scope === "all" || scope === "tokens") {
        delete record.tokens;
        delete record.tokensSavedAt;
      }

      if (scope === "all" || scope === "discovery") {
        delete record.discovery;
      }

      if (scope === "all" || scope === "verifier") {
        delete session.verifier;
      }
    },
  };

  const state = options.state;

  if (state !== undefined) {
    provider.state = () => state;
  }

  return provider;
};

const clientSecret = (config: MCPOAuthServer) =>
  Effect.gen(function* () {
    const reference = config.oauth.clientSecret;

    if (reference === undefined) {
      return undefined;
    }

    const key = yield* ApiKeyStore.use((store) => store.read(reference.credential)).pipe(
      Effect.mapError(
        () => new MCPSignInError({ message: `MCP ${config.id}: cannot read the client secret.` }),
      ),
    );

    if (key === null) {
      return yield* Effect.fail(
        new MCPSignInError({
          message: `MCP ${config.id}: the client secret credential ${reference.credential} is missing.`,
        }),
      );
    }

    return Redacted.value(key);
  });

const authOptions = (config: MCPOAuthServer, fetchFn: FetchLike) => {
  const options: AuthOptions = { serverUrl: config.url, fetchFn };

  if (config.oauth.resourceMetadataUrl !== undefined) {
    options.resourceMetadataUrl = new URL(config.oauth.resourceMetadataUrl);
  }

  if (config.oauth.scopes !== undefined) {
    options.scope = config.oauth.scopes.join(" ");
  }

  return options;
};

const Issued = Schema.Struct({
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
});

export const signInStatus = (config: MCPOAuthServer) =>
  Effect.gen(function* () {
    const saved = yield* MCPSignIns.use((signIns) => signIns.read(config.id));
    const token = tokenForServer(saved, config);

    const details = Option.getOrElse(Schema.decodeUnknownOption(Issued)(saved?.tokens ?? {}), () =>
      Issued.make({}),
    );

    return {
      signedIn: token !== null,
      expiresAt:
        token === null || details.expires_in === undefined || saved?.tokensSavedAt === undefined
          ? null
          : saved.tokensSavedAt + details.expires_in * 1000,
      scopes: token === null ? [] : (details.scope?.split(" ").filter(Boolean) ?? []),
    };
  });

export interface SignInOptions<E> extends Omit<BrowserOptions<E>, "service"> {
  readonly now: () => number;
}

export const signIn = <E>(config: MCPOAuthServer, options: SignInOptions<E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const signIns = yield* MCPSignIns;
      const secret = yield* clientSecret(config);
      const server = new URL(config.url);
      const session: Session = {};
      let authorizationURL: URL | undefined;

      const callback = yield* startCallback({
        port: config.oauth.callbackPort ?? null,
        service: `MCP ${config.id}`,
        received: "Return to your terminal while Poppet finishes signing in.",
        accept: (code, parameters) =>
          parameters.getAll("iss").length > 1
            ? null
            : { code, iss: parameters.get("iss") ?? undefined },
      });

      const failure = (cause: unknown) => {
        if (cause instanceof MCPSignInError) {
          return cause;
        }

        if (cause instanceof BlockedOAuthEndpoint) {
          return new MCPSignInError({ message: `MCP ${config.id}: ${cause.message}` });
        }

        const code =
          OAuthError.isInstance(cause) && /^[a-z0-9_]{1,64}$/.test(cause.code)
            ? cause.code
            : undefined;

        return new MCPSignInError({
          message:
            code === undefined
              ? `MCP ${config.id}: sign-in failed. Check the server's OAuth configuration.`
              : `MCP ${config.id}: sign-in failed (${code}). Check the server's OAuth configuration.`,
        });
      };

      const provider = (record: Working) =>
        makeProvider(config, record, session, {
          redirectUri: callback.redirectUri,
          state: callback.state,
          secret,
          now: options.now,
          redirect: (url) => {
            authorizationURL = url;
          },
        });

      const challenge = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await oauthFetch(server, signal)(config.url, {
            method: "GET",
            headers: { Accept: "application/json, text/event-stream" },
          });

          const parameters = response.status === 401 ? extractWWWAuthenticateParams(response) : {};
          await response.body?.cancel();

          return {
            ...parameters,
            resourceMetadataUrl: resourceMetadata(config, parameters.resourceMetadataUrl),
          };
        },
        catch: failure,
      });

      const saved = yield* signIns.read(config.id);
      const record = copy(saved, config.url);
      delete record.refreshLease;

      const target = yield* Effect.tryPromise({
        try: async (signal) => {
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
          const authorization = authOptions(config, oauthFetch(server, deadline));
          const advertised = challenge.resourceMetadataUrl?.href;

          if (record.discovery?.resourceMetadataUrl !== advertised) {
            delete record.discovery;
          }

          if (
            config.oauth.clientId === undefined &&
            registeredRedirect(record) !== callback.redirectUri
          ) {
            delete record.client;
          }

          if (challenge.resourceMetadataUrl !== undefined) {
            authorization.resourceMetadataUrl = challenge.resourceMetadataUrl;
          }

          if (authorization.scope === undefined && challenge.scope !== undefined) {
            authorization.scope = challenge.scope;
          }

          const result = await auth(provider(record), {
            ...authorization,
            forceReauthorization: true,
          });

          if (result !== "REDIRECT" || authorizationURL === undefined) {
            throw new MCPSignInError({
              message: `MCP ${config.id}: the authorization server did not start a browser sign-in.`,
            });
          }

          await oauthAddress(server, authorizationURL, deadline);

          return authorizationURL;
        },
        catch: failure,
      });

      const { code, iss } = yield* authorizeInBrowser(callback, target.href, {
        ...options,
        service: `MCP ${config.id}`,
      });

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(
            Effect.tryPromise({
              try: async (signal) => {
                const fetchFn = oauthFetch(
                  server,
                  AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                );

                const exchange: AuthOptions = {
                  ...authOptions(config, fetchFn),
                  authorizationCode: code,
                };

                if (iss !== undefined) {
                  exchange.iss = iss;
                }

                await auth(provider(record), exchange);

                if (accessToken(record) === null) {
                  throw new MCPSignInError({
                    message: `MCP ${config.id}: no access token was issued.`,
                  });
                }
              },
              catch: failure,
            }),
          );

          yield* signIns.update(config.id, (current) =>
            isDeepStrictEqual(current, saved)
              ? Effect.succeed(record)
              : Effect.fail(
                  new MCPSignInError({
                    message: `MCP ${config.id}: the saved sign-in changed during authorization. Sign in again.`,
                  }),
                ),
          );
        }),
      );
    }),
  );

export const signOut = (id: string) =>
  MCPSignIns.use((signIns) =>
    signIns.update(id, (saved) => {
      if (saved === null) {
        return Effect.succeed(null);
      }

      const { tokens: _tokens, tokensSavedAt: _savedAt, refreshLease: _lease, ...rest } = saved;

      return Effect.succeed(rest);
    }),
  );

export const forgetSignIn = (id: string) =>
  MCPSignIns.use((signIns) => signIns.update(id, () => Effect.succeed(null)));

export const runtimeAuthorization = (config: MCPOAuthServer, now: () => number) =>
  Effect.gen(function* () {
    const signIns = yield* MCPSignIns;
    const secret = yield* clientSecret(config);
    const read = signIns.read(config.id);
    const initial = tokenForServer(yield* read, config);

    if (initial === null) {
      return yield* Effect.fail(required(config.id, "sign-in required."));
    }

    let token = initial.access_token;
    const seenSecrets = new Set<string>();

    const track = (value: string | undefined) => {
      if (value !== undefined && value.length > 0) {
        seenSecrets.add(value);
      }
    };

    track(secret);
    track(initial.access_token);
    track(initial.refresh_token);

    let loginRequired = false;
    const server = new URL(config.url);
    const run = Effect.runPromiseWith(yield* Effect.context());

    const readToken = read.pipe(
      Effect.flatMap((current) => {
        const latest = tokenForServer(current, config);

        if (latest === null || loginRequired) {
          loginRequired = true;

          return Effect.fail(required(config.id, "sign-in required."));
        }

        track(latest.access_token);
        track(latest.refresh_token);
        token = latest.access_token;

        return Effect.succeed(token);
      }),
    );

    const exchange = (record: Working, refreshToken: string | undefined) =>
      // The MCP SDK inspects the original rejection, so it passes through unchanged.
      // @effect-diagnostics-next-line unknownInEffectCatch:off
      Effect.tryPromise({
        try: async (signal) => {
          if (refreshToken === undefined) {
            delete record.tokens;
            delete record.tokensSavedAt;

            return;
          }

          const advertised = record.discovery?.resourceMetadataUrl;

          if (Schema.is(Schema.String)(advertised)) {
            resourceMetadata(config, new URL(advertised));
          }

          const fetchFn = oauthFetch(
            server,
            AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          );

          const provider = makeProvider(
            config,
            record,
            {},
            {
              redirectUri: registeredRedirect(record) ?? "http://127.0.0.1/auth/callback",
              secret,
              allowRegistration: false,
              now,
              redirect: () => {
                throw new Error("Sign-in required.");
              },
            },
          );

          try {
            await auth(provider, authOptions(config, fetchFn));
          } catch (cause) {
            if (accessToken(record) !== null) {
              throw cause;
            }
          }

          const refreshed = accessToken(record);
          track(refreshed?.access_token);
          track(refreshed?.refresh_token);
        },
        catch: (cause) => cause,
      });

    const refresh = async (rejected: string, response: Response, signal?: AbortSignal) => {
      // Refresh stays bound to the saved issuer and registration.
      resourceMetadata(config, extractWWWAuthenticateParams(response).resourceMetadataUrl);
      const id = randomUUID();

      const renew = (current: SavedSignIn, refreshToken: string | undefined) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let claimed = false;
            yield* signIns.update(config.id, (previous) => {
              if (!isDeepStrictEqual(previous, current)) {
                return Effect.succeed(previous);
              }

              claimed = true;

              return Effect.succeed({
                ...current,
                refreshLease: { id, expiresAt: Date.now() + 20_000 },
              });
            });

            if (!claimed) {
              return false;
            }

            const { refreshLease: _lease, ...original } = current;
            const record = { ...original };

            let held = true;

            const save = (next: SavedSignIn) =>
              signIns.update(config.id, (previous) => {
                held = previous?.refreshLease?.id === id;

                return Effect.succeed(held ? next : previous);
              });

            yield* restore(exchange(record, refreshToken)).pipe(
              Effect.andThen(save(record)),
              Effect.onError(() =>
                save(original).pipe(
                  Effect.catch(() =>
                    Effect.logWarning("could not release MCP OAuth refresh lease").pipe(
                      Effect.annotateLogs({ server: config.id }),
                    ),
                  ),
                ),
              ),
            );

            if (!held) {
              return false;
            }

            yield* readToken;

            return true;
          }),
        );

      return run(
        Effect.gen(function* () {
          const limit = Date.now() + 25_000;

          while (true) {
            const current = yield* read;
            const latest = tokenForServer(current, config);

            if (current === null || latest === null) {
              break;
            }

            if (latest.access_token !== rejected) {
              track(latest.access_token);
              track(latest.refresh_token);
              token = latest.access_token;

              return;
            }

            if (Date.now() >= limit) {
              return yield* new MCPSignInError({ message: "MCP OAuth refresh timed out." });
            }

            if (
              current.refreshLease === undefined ||
              current.refreshLease.expiresAt <= Date.now()
            ) {
              if (yield* renew(current, latest.refresh_token)) {
                return;
              }
            } else {
              yield* Effect.sleep("50 millis");
            }
          }

          loginRequired = true;

          return yield* Effect.fail(required(config.id, "the saved sign-in was rejected."));
        }),
        signal === undefined ? undefined : { signal },
      );
    };

    return {
      readToken: () => run(readToken),
      refresh,
      token: () => token,
      secrets: () => [...seenSecrets],
      loginRequired: () => loginRequired,
    };
  });

export type RuntimeAuthorization = Effect.Success<ReturnType<typeof runtimeAuthorization>>;

export type { SignInError };
