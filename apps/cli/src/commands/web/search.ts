import { AgentError, ChatSettings } from "@poppet/agent";
import { webSearchEnabled, webSearchProvider } from "@poppet/config";
import { ApiKeyStore } from "@poppet/credentials";
import { WebSearch, searchProviders } from "@poppet/web-search";
import { Console, Effect, Layer } from "effect";

import { decodeKey, readHiddenKey } from "#src/api-key-input";

const searchProvider = Effect.map(webSearchProvider, (id) => ({ id, ...searchProviders[id] }));

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const provider = yield* searchProvider;

    if (!(yield* webSearchEnabled)) return { search: null };

    const key = yield* ApiKeyStore.use((store) => store.read(provider.credentialId)).pipe(
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

export const manageWebSearch = (action: "login" | "status" | "logout", apiKey?: string) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;
    const provider = yield* searchProvider;
    const { credentialId } = provider;

    if (action === "login") {
      const key = yield* apiKey === undefined
        ? readHiddenKey(
            credentialId,
            "Web search login needs an interactive terminal. Use --api-key <key>.",
          )
        : decodeKey(credentialId, apiKey);

      yield* store.write(credentialId, key);

      yield* Console.log(
        `${provider.name} key saved. Enable webSearch in config.json and restart the worker.`,
      );
    } else if (action === "logout") {
      yield* store.remove(credentialId);
      yield* Console.log(
        `Saved ${provider.name} key removed. Restart the worker; remote keys are not revoked.`,
      );
    } else {
      const key = yield* store.read(credentialId);
      yield* Console.log(
        JSON.stringify({
          provider: provider.id,
          enabled: yield* webSearchEnabled,
          configured: key !== null,
          source: key === null ? null : "stored",
        }),
      );
    }
  });
