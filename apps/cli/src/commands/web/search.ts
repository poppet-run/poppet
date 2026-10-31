import { AgentError, ChatSettings } from "@poppet/agent";
import { webSearchProvider } from "@poppet/config";
import { ApiKeyStore } from "@poppet/credentials";
import { WebSearch, searchProviders } from "@poppet/web-search";
import { Console, Effect, Layer } from "effect";

import { decodeKey, readHiddenKey } from "#src/api-key-input";
import { fields, printResult, yesNo } from "#src/output";

const searchProvider = Effect.map(webSearchProvider, (id) =>
  id === null ? null : { id, ...searchProviders[id] },
);

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const provider = yield* searchProvider;

    if (provider === null) return { search: null };

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

export const manageWebSearch = (
  action: "login" | "status" | "logout",
  apiKey?: string,
  json = false,
) =>
  Effect.gen(function* () {
    const store = yield* ApiKeyStore;
    const provider = yield* searchProvider;

    if (provider === null) {
      if (action === "status") {
        return yield* printResult(
          json,
          { provider: null, enabled: false, configured: false, source: null },
          () =>
            fields([
              ["Provider", "not set"],
              ["Enabled", "no"],
              ["API key", "not set"],
            ]),
        );
      }

      return yield* Effect.fail(
        new AgentError({
          reason: "tool-authentication",
          message: 'Set webSearchProvider to "brave" or "kagi" in config.json first.',
        }),
      );
    }

    const { credentialId } = provider;

    if (action === "login") {
      const key = yield* apiKey === undefined
        ? readHiddenKey(
            credentialId,
            "Web search login needs an interactive terminal. Use --api-key <key>.",
          )
        : decodeKey(credentialId, apiKey);

      yield* store.write(credentialId, key);

      yield* Console.log(`${provider.name} key saved. Restart the worker to use web search.`);
    } else if (action === "logout") {
      yield* store.remove(credentialId);
      yield* Console.log(
        `Saved ${provider.name} key removed. Restart the worker; remote keys are not revoked.`,
      );
    } else {
      const key = yield* store.read(credentialId);

      yield* printResult(
        json,
        {
          provider: provider.id,
          enabled: true,
          configured: key !== null,
          source: key === null ? null : "stored",
        },
        (status) =>
          fields([
            ["Provider", provider.name],
            ["Enabled", yesNo(status.enabled)],
            ["API key", status.configured ? "saved" : "not set"],
          ]),
      );
    }
  });
