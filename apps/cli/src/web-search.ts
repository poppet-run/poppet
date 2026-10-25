import { AgentError, ChatSettings } from "@poppet/agent";
import { webSearchEnabled, webSearchProvider } from "@poppet/config";
import { ApiKeyStore, findApiKey, saveApiKey } from "@poppet/credentials";
import { CredentialInput } from "@poppet/provider";
import { WebSearch, searchProviders } from "@poppet/web-search";
import { Console, Effect, Layer } from "effect";

import { terminalKeyInput } from "#src/api-key-input";

const searchProvider = Effect.map(webSearchProvider, (id) => ({ id, ...searchProviders[id] }));

export const WebSearchLive = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const provider = yield* searchProvider;

    if (!(yield* webSearchEnabled)) return { search: null };

    const { key } = yield* findApiKey(provider.credentialId, provider.keyEnvironment).pipe(
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
      yield* saveApiKey(credentialId, keyEnvironment, keyStdin).pipe(
        Effect.provideService(CredentialInput, terminalKeyInput),
      );
      yield* Console.log(
        `${provider.name} key saved. Enable webSearch in config.json and restart the worker.`,
      );
    } else if (action === "logout") {
      yield* store.remove(credentialId);
      yield* Console.log(
        `Saved ${provider.name} key removed. An environment key still overrides storage. Restart the worker; remote keys are not revoked.`,
      );
    } else {
      const { key, source } = yield* findApiKey(credentialId, keyEnvironment);
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
