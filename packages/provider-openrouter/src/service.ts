import { apiKeyProvider } from "@poppet/credentials";
import {
  invalidRequest,
  userAgent,
  type HttpFetch,
  type ProviderError,
  type ModelDescription,
  type ProviderOperations,
} from "@poppet/provider";
import { openAIClient, fetchModelCatalog, chatCompletionsModel } from "@poppet/provider-protocol";
import { Effect, Redacted, Schema } from "effect";

import { routerFailure, routerOptions } from "#src/protocol";

export type { HttpFetch } from "@poppet/provider";

const headers = {
  "User-Agent": userAgent,
  "HTTP-Referer": "https://poppet.run",
  "X-OpenRouter-Title": "Poppet",
};

const CatalogModel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  context_length: Schema.NullOr(Schema.Natural),
  architecture: Schema.Struct({
    input_modalities: Schema.Array(Schema.String),
    output_modalities: Schema.Array(Schema.String),
    tokenizer: Schema.NullOr(Schema.String),
  }),
  supported_parameters: Schema.Array(Schema.String),
  top_provider: Schema.Struct({ max_completion_tokens: Schema.NullOr(Schema.Natural) }),
});

const Catalog = Schema.Struct({ data: Schema.Array(CatalogModel) });

const supportsText = (model: typeof CatalogModel.Type) =>
  model.architecture.tokenizer !== "Router" &&
  !model.id.startsWith("~") &&
  model.id !== "openrouter/auto" &&
  model.id !== "openrouter/free" &&
  model.architecture.input_modalities.includes("text") &&
  model.architecture.output_modalities.length === 1 &&
  model.architecture.output_modalities[0] === "text";

const describeModel = (model: typeof CatalogModel.Type): ModelDescription => {
  const generationSettings: ModelDescription["capabilities"]["generationSettings"][number][] = [];

  if (model.supported_parameters.includes("temperature")) generationSettings.push("temperature");

  if (
    model.supported_parameters.some(
      (parameter) => parameter === "max_tokens" || parameter === "max_completion_tokens",
    )
  )
    generationSettings.push("maxOutputTokens");

  return {
    provider: "openrouter",
    id: model.id,
    name: model.name,
    capabilities: {
      tools:
        model.supported_parameters.includes("tools") &&
        model.supported_parameters.includes("tool_choice"),
      generationSettings,
      contextWindow: model.context_length,
      maxOutputTokens: model.top_provider.max_completion_tokens,
    },
  };
};

export const makeOpenRouterProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://openrouter.ai/api/v1",
): ProviderOperations => {
  const catalog = fetchModelCatalog({
    provider: "openrouter",
    label: "OpenRouter",
    url: `${baseUrl}/models`,
    http,
    headers,
    schema: Catalog,
    failure: routerFailure,
  }).pipe(Effect.map((value) => value.data.filter(supportsText)));

  return {
    id: "openrouter",
    models: catalog.pipe(Effect.map((models) => models.map(describeModel))),
    resolve: (modelId) =>
      Effect.gen(function* () {
        const models = yield* catalog;
        const selected = models.find((model) => model.id === modelId);

        if (!selected)
          return yield* Effect.fail(
            invalidRequest(
              "openrouter",
              "Choose a concrete text model ID from the OpenRouter catalog. No model fallback is allowed.",
            ),
          );

        const client = key.pipe(
          Effect.map((token) => openAIClient({ key: token, baseUrl, http, headers })),
        );

        return chatCompletionsModel(
          describeModel(selected),
          client,
          selected.supported_parameters.includes("max_tokens")
            ? "max_tokens"
            : "max_completion_tokens",
          routerOptions,
        );
      }),
  };
};

export const {
  loadApiKey,
  layer: OpenRouterLive,
  registration: openRouter,
} = apiKeyProvider({
  id: "openrouter",
  name: "OpenRouter",
  environment: "POPPET_OPENROUTER_API_KEY",
  make: makeOpenRouterProvider,
});
