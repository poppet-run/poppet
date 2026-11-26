import { createHash } from "node:crypto";

import { apiKeyProvider } from "@poppet/credentials";
import type {
  HttpFetch,
  ModelDescription,
  ModelOperations,
  ProviderError,
  ProviderId,
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
  cost: Schema.optionalKey(
    Schema.Struct({
      text: Schema.optionalKey(
        Schema.Struct({
          input: Schema.optionalKey(
            Schema.Struct({
              price: Schema.optionalKey(Schema.Number),
            }),
          ),
          output: Schema.optionalKey(
            Schema.Struct({
              price: Schema.optionalKey(Schema.Number),
            }),
          ),
        }),
      ),
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

const isFreeModel = (model: typeof CatalogModel.Type) =>
  model.go?.monthly_usage === null ||
  (model.cost?.text?.input?.price === 0 && model.cost?.text?.output?.price === 0);

const supportsChat = (model: typeof CatalogModel.Type) =>
  model.type === "chat" &&
  model.modalities.input.includes("text") &&
  model.modalities.output.length === 1 &&
  model.modalities.output[0] === "text" &&
  !isFreeModel(model);

const protocolFor = (model: typeof CatalogModel.Type): "responses" | "chat-completions" =>
  model.recommended_api === "responses" ||
  ((model.recommended_api === undefined || model.recommended_api === null) &&
    model.api !== undefined &&
    "responses" in model.api)
    ? "responses"
    : "chat-completions";

const describeModel = (provider: ProviderId, model: typeof CatalogModel.Type): ModelDescription => {
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
    provider,
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

const cacheKeyFor = (
  provider: ProviderId,
  baseUrl: string,
  token: Redacted.Redacted<string> | null,
) =>
  token === null
    ? `${provider}\0${baseUrl}\0public`
    : `${provider}\0${baseUrl}\0${createHash("sha256").update(Redacted.value(token)).digest("hex")}`;

export interface OpenCodeProviderOptions {
  readonly id?: ProviderId;
  readonly label?: string;
  readonly baseUrl?: string;
  readonly http?: HttpFetch;
  readonly optionalKey?: Effect.Effect<Redacted.Redacted<string> | null, ProviderError>;
}

export const makeOpenCodeProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  options: OpenCodeProviderOptions = {},
): ProviderOperations => {
  const id = options.id ?? "opencode-go";
  const label = options.label ?? "OpenCode Go";
  const baseUrl = options.baseUrl ?? "https://opencode.ai/inference/go/openai/v1";
  const http = options.http ?? fetch;

  const optionalKey =
    options.optionalKey ??
    key.pipe(
      Effect.catchIf(
        (error) => error.reason === "authentication",
        () => Effect.succeed(null),
      ),
    );

  const load = (token: Redacted.Redacted<string> | null) =>
    fetchModelCatalog({
      provider: id,
      label,
      url: `${baseUrl}/models`,
      http,
      headers:
        token === null
          ? { "User-Agent": userAgent }
          : { "User-Agent": userAgent, Authorization: `Bearer ${Redacted.value(token)}` },
      schema: Catalog,
      failure: (cause) => inferenceFailure(id, cause),
    }).pipe(
      Effect.flatMap((value) => {
        const models = value.data.flatMap((entry) => {
          const model = Schema.decodeUnknownOption(CatalogModel)(entry);

          return Option.isSome(model) ? [model.value] : [];
        });

        return models.length === 0 && value.data.length > 0
          ? Effect.fail(invalidRequest(id, `${label} returned an unsupported model catalog.`))
          : Effect.succeed(models.filter(supportsChat));
      }),
    );

  const readCatalog = (requested?: string) =>
    Effect.gen(function* () {
      const token = yield* optionalKey;

      return yield* catalogCache({
        http,
        key: cacheKeyFor(id, baseUrl, token),
        load: load(token),
      })(requested);
    });

  const models = readCatalog().pipe(
    Effect.map((entries) => entries.map((entry) => describeModel(id, entry))),
  );

  const resolve = (modelId: string) =>
    Effect.gen(function* () {
      const catalog = yield* readCatalog(modelId);
      const selected = catalog.find((model) => model.id === modelId);

      if (!selected) {
        return yield* Effect.fail(
          invalidRequest(
            id,
            `Choose a chat model ID from the ${label} catalog. No model fallback is allowed.`,
          ),
        );
      }

      const client = key.pipe(
        Effect.flatMap((token) =>
          openAIClient({ key: token, baseUrl, http, headers: { "User-Agent": userAgent } }),
        ),
      );

      const description = describeModel(id, selected);

      const model =
        protocolFor(selected) === "responses"
          ? responsesModel(description, client, { headers: sessionHeaders })
          : chatCompletionsModel(description, client, "max_tokens", goOptions);

      return model satisfies ModelOperations;
    });

  return { id, models, resolve };
};

export const { registration: openCode } = apiKeyProvider({
  id: "opencode",
  name: "OpenCode",
  environment: "POPPET_OPENCODE_API_KEY",
  make: (key, optionalKey) =>
    makeOpenCodeProvider(key, {
      id: "opencode",
      label: "OpenCode",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      optionalKey,
    }),
});

export const { registration: openCodeGo } = apiKeyProvider({
  id: "opencode-go",
  name: "OpenCode Go",
  environment: "POPPET_OPENCODE_GO_API_KEY",
  make: (key, optionalKey) =>
    makeOpenCodeProvider(key, {
      id: "opencode-go",
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      optionalKey,
    }),
});
