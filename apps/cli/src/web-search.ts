import { AgentError, ChatSettings } from "@poppet/agent";
import { webSearchEnabled, webSearchProvider } from "@poppet/config";
import { ApiKeyStore, environmentApiKey } from "@poppet/credentials";
import { WebSearch, makeBraveSearch, makeKagiSearch } from "@poppet/web-search";
import { Console, Effect, Layer, Option } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";

const searchProvider = Effect.gen(function* () {
  const provider = yield* webSearchProvider;

  return provider === "kagi"
    ? {
        id: provider,
        name: "Kagi Search",
        credentialId: "kagi-search",
        keyEnvironment: "POPPET_KAGI_SEARCH_API_KEY",
        make: makeKagiSearch,
      }
    : {
        id: provider,
        name: "Brave Search",
        credentialId: "brave-search",
        keyEnvironment: "POPPET_BRAVE_SEARCH_API_KEY",
        make: makeBraveSearch,
      };
});

const searchKey = (provider: { credentialId: string; keyEnvironment: string }) =>
  Effect.gen(function* () {
    const environment = yield* environmentApiKey(provider.credentialId, provider.keyEnvironment);

    if (Option.isSome(environment)) return { key: environment.value, source: "environment" };
    const key = yield* ApiKeyStore.use((store) => store.read(provider.credentialId));

    return { key, source: key === null ? null : "stored" };
  });

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const provider = yield* searchProvider;

    if (!(yield* webSearchEnabled)) return { search: null };

    const { key } = yield* searchKey(provider).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "tool-authentication",
            message: `Cannot load ${provider.name} credentials. Run web status to check setup.`,
          }),
      ),
    );

    const { toolBytes } = yield* ChatSettings;

    return key === null ? { search: null } : provider.make(key, toolBytes);
  }),
);

export const manageWebSearch = (action: "login" | "status" | "logout", keyStdin = false) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;
    const provider = yield* searchProvider;
    const { credentialId, keyEnvironment } = provider;

    if (action === "login") {
      let key = keyStdin
        ? yield* readKeyStdin(credentialId)
        : Option.getOrNull(yield* environmentApiKey(credentialId, keyEnvironment));

      if (key === null) key = yield* readHiddenKey(credentialId);

      yield* store.write(credentialId, key);
      yield* Console.log(
        `${provider.name} key saved. Enable webSearch in config.json and restart the worker.`,
      );
    } else if (action === "logout") {
      yield* store.remove(credentialId);
      yield* Console.log(
        `Saved ${provider.name} key removed. An environment key still overrides storage. Restart the worker; remote keys are not revoked.`,
      );
    } else {
      const { key, source } = yield* searchKey(provider);
      yield* Console.log(
        JSON.stringify({
          provider: provider.id,
          enabled: yield* webSearchEnabled,
          configured: key !== null,
          source,
        }),
      );
    }
  });
