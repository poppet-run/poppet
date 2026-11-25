import { createHash } from "node:crypto";

import { apiKeyProvider } from "@poppet/credentials";
import type {
  HttpFetch,
  ModelDescription,
  ModelOperations,
  ProviderError,
  ProviderOperations,
} from "@poppet/provider";
import { invalidRequest, userAgent } from "@poppet/provider";
import {
  chatCompletionsModel,
  createCatalogCache,
  fetchModelCatalog,
  inferenceFailure,
  openAIClient,
  responsesModel,
} from "@poppet/provider/protocol";
import { Effect, Option, Redacted, Schema } from "effect";

import { goOptions, sessionHeaders } from "#src/protocol";

export type { HttpFetch } from "@poppet/provider";

const supportedImageTypes = new Set<string>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const CatalogModel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  type: Schema.String,
  modalities: Schema.Struct({
    input: Schema.Array(Schema.String),
    output: Schema.Array(Schema.String),
  }),
  capabilities: Schema.Struct({
    tools: Schema.optionalKey(
      Schema.Struct({
        supported: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    temperature: Schema.optionalKey(Schema.Boolean),
  }),
  limit: Schema.optionalKey(
    Schema.Struct({
      context: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
      output: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
    }),
  ),
  recommended_api: Schema.optionalKey(Schema.NullOr(Schema.String)),
  api: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  go: Schema.optionalKey(
    Schema.Struct({
      monthly_usage: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
    }),
  ),
});

const Catalog = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const supportsChat = (model: typeof CatalogModel.Type) =>
  model.type === "chat" &&
  model.modalities.input.includes("text") &&
  model.modalities.output.length === 1 &&
  model.modalities.output[0] === "text" &&
  model.go?.monthly_usage !== null;

const protocolFor = (model: typeof CatalogModel.Type): "responses" | "chat-completions" =>
  model.recommended_api === "responses" ||
  ((model.recommended_api === undefined || model.recommended_api === null) &&
    model.api !== undefined &&
    "responses" in model.api)
    ? "responses"
    : "chat-completions";

const describeModel = (model: typeof CatalogModel.Type): ModelDescription => {
  const generationSettings: Array<ModelDescription["capabilities"]["generationSettings"][number]> =
    [];

  if (model.capabilities.temperature === true) {
    generationSettings.push("temperature");
  }

  generationSettings.push("maxOutputTokens");

  const contextWindow =
    model.limit?.context !== undefined && model.limit.context !== null && model.limit.context > 0
      ? model.limit.context
      : null;

  const maxOutputTokens =
    model.limit?.output !== undefined && model.limit.output !== null && model.limit.output > 0
      ? model.limit.output
      : null;

  return {
    provider: "opencode-go",
    id: model.id,
    name: model.name ?? model.id,
    capabilities: {
      tools: model.capabilities.tools?.supported === true,
      images: model.modalities.input.some(
        (modality) => modality === "image" || supportedImageTypes.has(modality),
      ),
      generationSettings,
      contextWindow,
      maxOutputTokens,
    },
  };
};

const catalogCache = createCatalogCache<typeof CatalogModel.Type>();

const cacheKeyFor = (baseUrl: string, token: Redacted.Redacted<string> | null) =>
  token === null
    ? `${baseUrl}\0public`
    : `${baseUrl}\0${createHash("sha256").update(Redacted.value(token)).digest("hex")}`;

export const makeOpenCodeProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://opencode.ai/inference/go/openai/v1",
  optionalKey: Effect.Effect<Redacted.Redacted<string> | null, ProviderError> = key.pipe(
    Effect.catchIf(
      (error) => error.reason === "authentication",
      () => Effect.succeed(null),
    ),
  ),
): ProviderOperations => {
  const load = (token: Redacted.Redacted<string> | null) =>
    fetchModelCatalog({
      provider: "opencode-go",
      label: "OpenCode Go",
      url: `${baseUrl}/models`,
      http,
      headers:
        token === null
          ? { "User-Agent": userAgent }
          : { "User-Agent": userAgent, Authorization: `Bearer ${Redacted.value(token)}` },
      schema: Catalog,
      failure: (cause) => inferenceFailure("opencode-go", cause),
    }).pipe(
      Effect.flatMap((value) => {
        const models = value.data.flatMap((entry) => {
          const model = Schema.decodeUnknownOption(CatalogModel)(entry);

          return Option.isSome(model) ? [model.value] : [];
        });

        return models.length === 0 && value.data.length > 0
          ? Effect.fail(
              invalidRequest("opencode-go", "OpenCode Go returned an unsupported model catalog."),
            )
          : Effect.succeed(models.filter(supportsChat));
      }),
    );

  const readCatalog = (requested?: string) =>
    Effect.gen(function* () {
      const token = yield* optionalKey;

      return yield* catalogCache({
        http,
        key: cacheKeyFor(baseUrl, token),
        load: load(token),
      })(requested);
    });

  const models = readCatalog().pipe(Effect.map((entries) => entries.map(describeModel)));

  const resolve = (modelId: string) =>
    Effect.gen(function* () {
      const catalog = yield* readCatalog(modelId);
      const selected = catalog.find((model) => model.id === modelId);

      if (!selected) {
        return yield* Effect.fail(
          invalidRequest(
            "opencode-go",
            "Choose a chat model ID from the OpenCode Go catalog. No model fallback is allowed.",
          ),
        );
      }

      const client = key.pipe(
        Effect.map((token) =>
          openAIClient({ key: token, baseUrl, http, headers: { "User-Agent": userAgent } }),
        ),
      );

      const description = describeModel(selected);

      const model =
        protocolFor(selected) === "responses"
          ? responsesModel(description, client, { headers: sessionHeaders })
          : chatCompletionsModel(description, client, "max_tokens", goOptions);

      return model satisfies ModelOperations;
    });

  return { id: "opencode-go", models, resolve };
};

export const { registration: openCodeGo } = apiKeyProvider({
  id: "opencode-go",
  name: "OpenCode Go",
  environment: "POPPET_OPENCODE_GO_API_KEY",
  make: (key, optionalKey) => makeOpenCodeProvider(key, fetch, undefined, optionalKey),
});
