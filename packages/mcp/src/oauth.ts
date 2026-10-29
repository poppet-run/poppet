import {
  auth,
  extractWWWAuthenticateParams,
  type AuthOptions,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import { makeRecordStore, RecordStoreError } from "@poppet/credentials/records";
import { ProviderEnvironment } from "@poppet/provider";
import {
  authorizeInBrowser,
  startCallback,
  type BrowserOptions,
  type SignInError,
} from "@poppet/sign-in";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

import type { MCPHTTPServer, MCPOAuth } from "#src/config";
import { boundedFetch } from "#src/transport";

/** An OAuth server whose saved sign-in is missing, unusable here, or was rejected. */
export class MCPLoginRequired extends Data.TaggedError("MCPLoginRequired")<{
  readonly message: string;
}> {}

/** Sign-in could not discover, register, authorize or exchange tokens. */
export class MCPSignInError extends Data.TaggedError("MCPSignInError")<{
  readonly message: string;
}> {}

export type MCPOAuthServer = MCPHTTPServer & { readonly oauth: MCPOAuth };

export const isOAuthServer = (server: MCPHTTPServer): server is MCPOAuthServer =>
  server.oauth !== undefined;

/**
 * One server's saved sign-in. Tokens apply only to the URL they were issued for. Client,
 * token and discovery objects are written by the SDK after it validates each response.
 */
const SavedSignIn = Schema.Struct({
  url: Schema.String,
  client: Schema.optionalKey(Schema.JsonObject),
  tokens: Schema.optionalKey(Schema.JsonObject),
  tokensSavedAt: Schema.optionalKey(Schema.Number),
  discovery: Schema.optionalKey(Schema.JsonObject),
});

type SavedSignIn = typeof SavedSignIn.Type;

/** A working copy the SDK provider mutates; it is written back as a whole under the record lock. */
interface Working {
  url: string;
  client?: Schema.JsonObject;
  tokens?: Schema.JsonObject;
  tokensSavedAt?: number;
  discovery?: Schema.JsonObject;
}

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

/** Protected sign-in records under `<data directory>/auth`, one per OAuth server. */
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

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

const secure = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname));

/**
 * Discovery, registration and token requests share the MCP size cap and never use plain HTTP
 * beyond this machine. Configured MCP headers are not sent to authorization servers.
 */
export const oauthFetch =
  (base: FetchLike = boundedFetch(262144)): FetchLike =>
  (url, init) =>
    secure(new URL(String(url)))
      ? base(url, init)
      : Promise.reject(new Error("OAuth endpoints must use https."));

const JSONObject = Schema.fromJsonString(Schema.JsonObject);

/** SDK credential objects are plain JSON apart from absent optional fields, which are dropped. */
const json = <A extends object>(value: A) =>
  Schema.decodeUnknownSync(JSONObject)(JSON.stringify(value));

const copy = (saved: SavedSignIn | null, url: string): Working =>
  // Tokens and registrations for another URL never reach this one.
  saved === null || saved.url !== url ? { url } : { ...saved };

const AccessToken = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});

const accessToken = (record: Working | SavedSignIn | null) =>
  record?.tokens === undefined
    ? null
    : Option.getOrNull(Schema.decodeUnknownOption(AccessToken)(record.tokens));

const RedirectURIs = Schema.Struct({ redirect_uris: Schema.Array(Schema.String) });

const registeredRedirect = (record: Working) =>
  record.client === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(RedirectURIs)(record.client))
        ?.redirect_uris[0];

const Stamped = Schema.Struct({ client_id: Schema.String, issuer: Schema.String });

/** The PKCE verifier exists only in memory for one sign-in attempt. */
interface Session {
  verifier?: string;
}

interface ProviderOptions {
  readonly redirectUri: string;
  readonly state?: string;
  readonly secret: string | undefined;
  readonly redirect: (url: URL) => void;
  readonly now: () => number;
}

/**
 * Adapts a working record to the SDK's OAuth client. A configured client ID takes precedence
 * over any registration; its secret comes from protected credentials and is never saved.
 */
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
      if (configured === undefined)
        // SAFETY: saveClientInformation stores only SDK-validated registrations.
        return record.client as StoredOAuthClientInformation | undefined;

      const information: StoredOAuthClientInformation = { client_id: configured };
      const saved = Option.getOrUndefined(Schema.decodeUnknownOption(Stamped)(record.client));
      const issuer = saved?.client_id === configured ? saved.issuer : undefined;

      if (options.secret !== undefined) information.client_secret = options.secret;

      if (issuer !== undefined) information.issuer = issuer;

      return information;
    },
    saveClientInformation: (information) => {
      record.client =
        configured === undefined
          ? json(information)
          : json({ client_id: configured, issuer: information.issuer });
    },
    // SAFETY: saveTokens stores only SDK-validated token responses.
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
      if (session.verifier === undefined) throw new Error("No sign-in is in progress.");

      return session.verifier;
    },
    saveDiscoveryState: (state) => {
      record.discovery = json(state);
    },
    // SAFETY: saveDiscoveryState stores only SDK-validated discovery results.
    discoveryState: () => record.discovery as OAuthDiscoveryState | undefined,
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") delete record.client;

      if (scope === "all" || scope === "tokens") {
        delete record.tokens;
        delete record.tokensSavedAt;
      }

      if (scope === "all" || scope === "discovery") delete record.discovery;

      if (scope === "all" || scope === "verifier") delete session.verifier;
    },
  };

  const state = options.state;

  if (state !== undefined) provider.state = () => state;

  return provider;
};

const clientSecret = (config: MCPOAuthServer) =>
  Effect.gen(function* () {
    const reference = config.oauth.clientSecret;

    if (reference === undefined) return undefined;

    const key = yield* ApiKeyStore.use((store) => store.read(reference.credential)).pipe(
      Effect.mapError(
        () => new MCPSignInError({ message: `MCP ${config.id}: cannot read the client secret.` }),
      ),
    );

    if (key === null)
      return yield* Effect.fail(
        new MCPSignInError({
          message: `MCP ${config.id}: the client secret credential ${reference.credential} is missing.`,
        }),
      );

    return Redacted.value(key);
  });

/** Requests the configured scopes, or lets the SDK choose from the server's metadata. */
const authOptions = (config: MCPOAuthServer, fetchFn: FetchLike) => {
  const options: AuthOptions = { serverUrl: config.url, fetchFn };

  if (config.oauth.scopes !== undefined) options.scope = config.oauth.scopes.join(" ");

  return options;
};

const Issued = Schema.Struct({
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
});

/** Saved sign-in state for inspection, without token values. */
export const signInStatus = (config: MCPOAuthServer) =>
  Effect.gen(function* () {
    const saved = yield* MCPSignIns.use((signIns) => signIns.read(config.id));
    const token = saved?.url === config.url ? accessToken(saved) : null;

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

/**
 * Signs in through the browser. Discovery and registration run under the record lock, the
 * browser step does not, and the code exchange replaces tokens under the lock again, so a worker
 * refreshing meanwhile waits at most for one locked step.
 */
export const signIn = <E>(config: MCPOAuthServer, options: SignInOptions<E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const signIns = yield* MCPSignIns;
      const secret = yield* clientSecret(config);
      const fetchFn = oauthFetch();
      const session: Session = {};
      let authorizationURL: URL | undefined;

      const callback = yield* startCallback({
        port: config.oauth.callbackPort ?? null,
        service: `MCP ${config.id}`,
        received: "Return to your terminal while Poppet finishes signing in.",
        accept: (code, parameters) => ({ code, iss: parameters.get("iss") ?? undefined }),
      });

      const failure = (cause: unknown) =>
        new MCPSignInError({
          message: `MCP ${config.id}: sign-in failed. ${cause instanceof Error ? cause.message : "Check the server's OAuth configuration."}`,
        });

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

      // Ask the resource itself before falling back to well-known discovery. Never
      // forward endpoint credentials or follow redirects to an authorization server.
      const challenge = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchFn(config.url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            headers: { Accept: "application/json, text/event-stream" },
          });

          const parameters = response.status === 401 ? extractWWWAuthenticateParams(response) : {};
          await response.body?.cancel();

          return parameters;
        },
        catch: failure,
      });

      yield* signIns.update(config.id, (saved) =>
        Effect.tryPromise({
          try: async () => {
            const record = copy(saved, config.url);

            // A registration for another callback address cannot complete this attempt.
            if (
              config.oauth.clientId === undefined &&
              registeredRedirect(record) !== callback.redirectUri
            )
              delete record.client;

            const authorization = authOptions(config, fetchFn);

            if (challenge.resourceMetadataUrl !== undefined) {
              authorization.resourceMetadataUrl = challenge.resourceMetadataUrl;

              if (record.discovery?.resourceMetadataUrl !== challenge.resourceMetadataUrl.href)
                delete record.discovery;
            }

            if (authorization.scope === undefined && challenge.scope !== undefined)
              authorization.scope = challenge.scope;

            const result = await auth(provider(record), {
              ...authorization,
              forceReauthorization: true,
            });

            if (result !== "REDIRECT" || authorizationURL === undefined)
              throw new Error("The authorization server did not start a browser sign-in.");

            return record;
          },
          catch: failure,
        }),
      );

      if (authorizationURL === undefined || !secure(authorizationURL))
        return yield* Effect.fail(
          new MCPSignInError({
            message: `MCP ${config.id}: the authorization endpoint must use https.`,
          }),
        );

      const { code, iss } = yield* authorizeInBrowser(callback, authorizationURL.href, {
        ...options,
        service: `MCP ${config.id}`,
      });

      yield* signIns.update(config.id, (saved) =>
        Effect.tryPromise({
          try: async () => {
            if (saved?.url !== config.url || saved.discovery === undefined)
              throw new Error("The saved sign-in changed during authorization. Sign in again.");

            const record = copy(saved, config.url);

            const exchange: AuthOptions = {
              ...authOptions(config, fetchFn),
              authorizationCode: code,
            };

            if (iss !== undefined) exchange.iss = iss;

            await auth(provider(record), exchange);

            if (accessToken(record) === null) throw new Error("No access token was issued.");

            return record;
          },
          catch: failure,
        }),
      );
    }),
  );

/** Clears tokens and keeps the registration, so the next sign-in can reuse it. */
export const signOut = (id: string) =>
  MCPSignIns.use((signIns) =>
    signIns.update(id, (saved) => {
      if (saved === null) return Effect.succeed(null);

      const { tokens: _tokens, tokensSavedAt: _savedAt, ...rest } = saved;

      return Effect.succeed(rest);
    }),
  );

/** Deletes the whole record, including any registration. */
export const forgetSignIn = (id: string) =>
  MCPSignIns.use((signIns) => signIns.update(id, () => Effect.succeed(null)));

/**
 * Bearer tokens for a running connection. A 401 refreshes under the record lock; when another
 * process already refreshed, its token is adopted instead of spending the refresh token again.
 * A run never opens a browser: a rejected or missing refresh token requires `mcp login`.
 */
export const runtimeAuthorization = (config: MCPOAuthServer, now: () => number) =>
  Effect.gen(function* () {
    const signIns = yield* MCPSignIns;
    const secret = yield* clientSecret(config);
    const saved = yield* signIns.read(config.id);
    const initial = saved?.url === config.url ? accessToken(saved) : null;

    if (initial === null) return yield* Effect.fail(required(config.id, "sign-in required."));

    let token = initial.access_token;
    const state = { loginRequired: false };
    const fetchFn = oauthFetch();

    const refresh = signIns.update(config.id, (current) =>
      Effect.tryPromise({
        try: async () => {
          const record = copy(current, config.url);
          const latest = accessToken(record);

          if (latest !== null && latest.access_token !== token) {
            token = latest.access_token;

            return current;
          }

          if (latest?.refresh_token === undefined) {
            state.loginRequired = true;

            if (current === null || current.url !== config.url) return current;
            delete record.tokens;
            delete record.tokensSavedAt;

            return record;
          }

          const provider = makeProvider(
            config,
            record,
            {},
            {
              redirectUri: registeredRedirect(record) ?? "http://127.0.0.1/auth/callback",
              secret,
              now,
              redirect: () => {
                throw new Error("Sign-in required.");
              },
            },
          );

          try {
            await auth(provider, authOptions(config, fetchFn));
          } catch (cause) {
            // The SDK clears tokens only when the authorization server rejected them. Any other
            // failure keeps them for a later attempt.
            if (accessToken(record) === null) {
              state.loginRequired = true;

              return record;
            }

            throw cause;
          }

          token = accessToken(record)?.access_token ?? token;

          return record;
        },
        catch: (cause) => cause,
      }),
    );

    const authProvider: AuthProvider = {
      token: async () => {
        const current = await Effect.runPromise(signIns.read(config.id));
        const latest = current?.url === config.url ? accessToken(current) : null;

        if (latest === null || state.loginRequired) {
          state.loginRequired = true;
          throw required(config.id, "sign-in required.");
        }

        token = latest.access_token;

        return token;
      },
      onUnauthorized: async () => {
        await Effect.runPromise(refresh);

        if (state.loginRequired) throw required(config.id, "the saved sign-in was rejected.");
      },
    };

    return {
      authProvider,
      /** The current access token, redacted from results because refresh replaces it. */
      token: () => token,
      loginRequired: () => state.loginRequired,
    };
  });

export type RuntimeAuthorization = Effect.Success<ReturnType<typeof runtimeAuthorization>>;

export type { SignInError };
