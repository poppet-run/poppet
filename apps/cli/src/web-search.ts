import {
  AgentError,
  BraveSearchResponse,
  ChatSettings,
  WebSearch,
  webSearchResult,
} from "@poppet/agent";
import { webSearchEnabled } from "@poppet/config";
import { ApiKeyStore, environmentApiKey } from "@poppet/credentials";
import { readBoundedText } from "@poppet/io";
import { Console, Effect, Layer, Option, Redacted, Schema } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";

const credentialId = "brave-search";

const keyEnvironment = "POPPET_BRAVE_SEARCH_API_KEY";

const maxSearchBytes = 1048576;

const searchFailure = () =>
  new AgentError({ reason: "tool-network", message: "Could not search Brave Search." });

const searchKey = Effect.gen(function* () {
  const environment = yield* environmentApiKey(credentialId, keyEnvironment);

  if (Option.isSome(environment)) return { key: environment.value, source: "environment" };
  const key = yield* ApiKeyStore.use((store) => store.read(credentialId));

  return { key, source: key === null ? null : "stored" };
});

/** Fixed endpoint and explicit redirect rejection keep the search key at Brave. */
export const makeWebSearch = (
  key: Redacted.Redacted<string>,
  toolBytes: number,
  httpFetch: typeof fetch = fetch,
): WebSearch["Service"] => ({
  search: (query) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.search = new URLSearchParams({
          q: query,
          count: "5",
          result_filter: "web",
          text_decorations: "false",
        }).toString();

        const response = await httpFetch(url, {
          signal,
          redirect: "error",
          headers: { Accept: "application/json", "X-Subscription-Token": Redacted.value(key) },
        });

        try {
          if (!response.ok)
            throw new AgentError({
              reason:
                response.status === 401 || response.status === 403
                  ? "tool-authentication"
                  : response.status === 429
                    ? "tool-rate-limit"
                    : "tool-network",
              message: `Brave Search returned HTTP ${response.status}.`,
            });

          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
            throw searchFailure();

          if (!response.body) throw searchFailure();

          const text = await readBoundedText(
            response.body,
            maxSearchBytes,
            () =>
              new AgentError({
                reason: "tool-limit",
                message: "The search response exceeds the 1 MiB body limit.",
              }),
          );

          return webSearchResult(
            Schema.decodeUnknownSync(Schema.fromJsonString(BraveSearchResponse))(text),
            toolBytes,
          );
        } finally {
          await response.body?.cancel().catch(() => undefined);
        }
      },
      catch: (cause) => (cause instanceof AgentError ? cause : searchFailure()),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new AgentError({
              reason: "tool-network",
              message: "The search request exceeded its 15-second deadline.",
            }),
          ),
      }),
    ),
});

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    if (!(yield* webSearchEnabled)) return { search: null };

    const { key } = yield* searchKey.pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "tool-authentication",
            message: "Cannot load Brave Search credentials. Run web status to check setup.",
          }),
      ),
    );

    const { toolBytes } = yield* ChatSettings;

    return key === null ? { search: null } : makeWebSearch(key, toolBytes);
  }),
);

export const manageWebSearch = (action: "login" | "status" | "logout", keyStdin = false) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;

    if (action === "login") {
      let key = keyStdin
        ? yield* readKeyStdin(credentialId)
        : Option.getOrNull(yield* environmentApiKey(credentialId, keyEnvironment));

      if (key === null) key = yield* readHiddenKey(credentialId);

      yield* store.write(credentialId, key);
      yield* Console.log(
        "Brave Search key saved. Enable webSearch in config.json and restart the worker.",
      );
    } else if (action === "logout") {
      yield* store.remove(credentialId);
      yield* Console.log(
        "Saved Brave Search key removed. An environment key still overrides storage. Restart the worker; remote keys are not revoked.",
      );
    } else {
      const { key, source } = yield* searchKey;
      yield* Console.log(
        JSON.stringify({ enabled: yield* webSearchEnabled, configured: key !== null, source }),
      );
    }
  });
