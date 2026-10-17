import {
  ApiKeyStoreLive,
  makeApiKeyConnection,
  loadApiKey as storedApiKey,
} from "@poppet/credentials";
import {
  Provider,
  ProviderEnvironment,
  ProviderConnection,
  type ProviderRegistration,
  ProviderError,
  invalidRequest,
  type ModelDescription,
  type ProviderOperations,
} from "@poppet/provider";
import { chatCompletionsModel } from "@poppet/provider-protocol";
import { Effect, Layer, Redacted, Schema } from "effect";
import OpenAI, { APIError } from "openai";

import { routerFailure, routerOptions } from "#src/protocol";

export type HttpFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const headers = {
  "User-Agent": "poppet/0.0.0",
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

const apiKeyEnvironment = "POPPET_OPENROUTER_API_KEY";

export const loadApiKey = storedApiKey("openrouter", apiKeyEnvironment);

export const makeOpenRouterProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://openrouter.ai/api/v1",
): ProviderOperations => {
  const catalog = Effect.gen(function* () {
    // Keep the fetch and body read inside one cancellation boundary.
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await http(`${baseUrl}/models`, { signal, headers });

        if (!response.ok) {
          await response.body?.cancel();
          throw routerFailure(
            new APIError(response.status, undefined, undefined, response.headers),
          );
        }

        try {
          return await response.json();
        } catch {
          throw invalidRequest("openrouter", "OpenRouter returned an invalid model catalog.");
        }
      },
      catch: (cause) => routerFailure(cause),
    });

    return yield* Schema.decodeUnknownEffect(Catalog)(body).pipe(
      Effect.mapError(() =>
        invalidRequest("openrouter", "OpenRouter returned an unsupported model catalog."),
      ),
      Effect.map((value) => value.data.filter(supportsText)),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new ProviderError({
            provider: "openrouter",
            reason: "temporary",
            message: "OpenRouter model discovery timed out.",
          }),
        ),
    }),
  );

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
          Effect.map(
            (token) =>
              new OpenAI({
                apiKey: Redacted.value(token),
                baseURL: baseUrl,
                fetch: http,
                maxRetries: 0,
                logLevel: "off",
                timeout: 45_000,
                defaultHeaders: headers,
              }),
          ),
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

const inference = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const environment = yield* ProviderEnvironment;

    return makeOpenRouterProvider(
      loadApiKey.pipe(Effect.provideService(ProviderEnvironment, environment)),
    );
  }),
);

export const OpenRouterLive = Layer.effect(
  ProviderConnection,
  Provider.use((provider) => makeApiKeyConnection(provider, apiKeyEnvironment)),
).pipe(Layer.provideMerge([inference, ApiKeyStoreLive]));

export const openRouter: ProviderRegistration = {
  id: "openrouter",
  name: "OpenRouter",
  authentication: {
    consent: false,
    apiKey: true,
    help: "API key from hidden input, --key-stdin, or POPPET_OPENROUTER_API_KEY.",
  },
  layer: OpenRouterLive,
};
