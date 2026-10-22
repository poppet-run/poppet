import { AgentError, ChatSettings, WebSearch, makeWebSearch } from "@poppet/agent";
import { webSearchEnabled } from "@poppet/config";
import { ApiKeyStore, environmentApiKey } from "@poppet/credentials";
import { Console, Effect, Layer, Option } from "effect";

import { readHiddenKey, readKeyStdin } from "#src/api-key-input";

const credentialId = "brave-search";

const keyEnvironment = "POPPET_BRAVE_SEARCH_API_KEY";

const searchKey = Effect.gen(function* () {
  const environment = yield* environmentApiKey(credentialId, keyEnvironment);

  if (Option.isSome(environment)) return { key: environment.value, source: "environment" };
  const key = yield* ApiKeyStore.use((store) => store.read(credentialId));

  return { key, source: key === null ? null : "stored" };
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
