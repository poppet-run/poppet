import { apiKeyProvider } from "@poppet/credentials";
import {
  ModelDescription,
  ProviderError,
  invalidRequest,
  userAgent,
  type HttpFetch,
  type ModelOperations,
  type ProviderOperations,
} from "@poppet/provider";
import {
  openAIClient,
  fetchModelCatalog,
  inferenceFailure,
  chatCompletionsModel,
  responsesModel,
} from "@poppet/provider/protocol";
import { Effect, Redacted, Schema } from "effect";

import { sessionHeaders, goOptions } from "#src/protocol";

export type { HttpFetch } from "@poppet/provider";

const Catalog = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) });

// Expand this list only after the model's protocol and continuation are tested.
const supportedModels: ReadonlyArray<
  ModelDescription & { readonly protocol: "responses" | "chat-completions" }
> = [
  {
    provider: "opencode-go",
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    protocol: "responses",
    capabilities: {
      tools: true,
      images: false,
      generationSettings: ["maxOutputTokens"],
      contextWindow: null,
      maxOutputTokens: null,
    },
  },
  {
    provider: "opencode-go",
    id: "glm-5.3",
    name: "GLM-5.3",
    protocol: "chat-completions",
    capabilities: {
      tools: true,
      images: false,
      generationSettings: ["temperature", "maxOutputTokens"],
      contextWindow: null,
      maxOutputTokens: null,
    },
  },
];

export const makeOpenCodeProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://opencode.ai/inference/go/v1",
): ProviderOperations => {
  const models = fetchModelCatalog({
    provider: "opencode-go",
    label: "OpenCode Go",
    url: `${baseUrl}/models`,
    http,
    headers: { "User-Agent": userAgent },
    schema: Catalog,
    failure: (cause) => inferenceFailure("opencode-go", cause),
  }).pipe(
    Effect.map((catalog) =>
      supportedModels
        .values()
        .filter((model) => catalog.data.some((entry) => entry.id === model.id))
        .map((model) => Schema.decodeUnknownSync(ModelDescription)(model))
        .toArray(),
    ),
  );

  const resolve = (modelId: string) =>
    Effect.gen(function* () {
      const supported = supportedModels.find((model) => model.id === modelId);

      if (!supported)
        return yield* Effect.fail(
          invalidRequest(
            "opencode-go",
            "This OpenCode Go model is not supported yet. Choose gpt-6-luna or glm-5.3.",
          ),
        );

      const catalog = yield* models;
      const description = catalog.find((model) => model.id === modelId);

      if (!description)
        return yield* Effect.fail(
          invalidRequest(
            "opencode-go",
            "The selected model is absent from the OpenCode Go catalog.",
          ),
        );

      const client = key.pipe(
        Effect.map((token) =>
          openAIClient({ key: token, baseUrl, http, headers: { "User-Agent": userAgent } }),
        ),
      );

      const model =
        supported.protocol === "responses"
          ? responsesModel(description, client, { headers: sessionHeaders })
          : chatCompletionsModel(description, client, "max_tokens", goOptions);

      return model satisfies ModelOperations;
    });

  return { id: "opencode-go", models, resolve };
};

export const {
  loadApiKey,
  layer: OpenCodeGoLive,
  registration: openCodeGo,
} = apiKeyProvider({
  id: "opencode-go",
  name: "OpenCode Go",
  environment: "POPPET_OPENCODE_GO_API_KEY",
  make: makeOpenCodeProvider,
});
