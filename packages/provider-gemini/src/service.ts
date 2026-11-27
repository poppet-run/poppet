import { createHash } from "node:crypto";

import { apiKeyProvider } from "@poppet/credentials";
import { timeout } from "@poppet/io";
import { ProviderError, invalidRequest } from "@poppet/provider";
import type { HttpFetch, ModelDescription, ProviderOperations } from "@poppet/provider";
import { createCatalogCache } from "@poppet/provider/protocol";
import { Effect, Option, Redacted, Schema } from "effect";

import { geminiFailure, geminiModel, httpFailure, keyHeaders } from "#src/protocol";

export type { HttpFetch } from "@poppet/provider";

const CatalogModel = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isStartingWith("models/")),
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  inputTokenLimit: Schema.optionalKey(Schema.Natural),
  outputTokenLimit: Schema.optionalKey(Schema.Natural),
  supportedGenerationMethods: Schema.Array(Schema.String),
  temperature: Schema.optionalKey(Schema.Number),
  thinking: Schema.optionalKey(Schema.Boolean),
});

const Page = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  nextPageToken: Schema.optionalKey(Schema.String),
});

interface CatalogEntry {
  readonly id: string;
  readonly model: typeof CatalogModel.Type;
}

const maxPages = 20;

// Gemma models reject system instructions and function declarations, and these variants
// generate images, speech, or live audio, or need a dedicated tool.
const excluded = /(^|-)(image|tts|audio|live|embedding|computer-use)(-|$)/;

const supportsChat = ({ id, model }: CatalogEntry) =>
  id.startsWith("gemini-") &&
  !excluded.test(id) &&
  model.supportedGenerationMethods.includes("generateContent");

const describeModel = ({ id, model }: CatalogEntry): ModelDescription => ({
  provider: "gemini",
  id,
  name: model.displayName ?? id,
  capabilities: {
    tools: true,
    images: true,
    generationSettings:
      model.temperature === undefined ? ["maxOutputTokens"] : ["temperature", "maxOutputTokens"],
    contextWindow: model.inputTokenLimit ?? null,
    maxOutputTokens: model.outputTokenLimit ?? null,
  },
});

const unsupportedCatalog = () =>
  invalidRequest("gemini", "Gemini returned an unsupported model catalog.");

const catalogCache = createCatalogCache<CatalogEntry>();

export const makeGeminiProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): ProviderOperations => {
  const page = (token: Redacted.Redacted<string>, pageToken: string | undefined) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = new URL(`${baseUrl}/models`);
        url.searchParams.set("pageSize", "1000");

        if (pageToken !== undefined) {
          url.searchParams.set("pageToken", pageToken);
        }

        const response = await http(url.toString(), { signal, headers: keyHeaders(token) });

        if (!response.ok) {
          throw await httpFailure(response, signal);
        }

        let body: unknown;

        try {
          body = await response.json();
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) {
            throw cause;
          }

          throw invalidRequest("gemini", "Gemini returned an invalid model catalog.");
        }

        return Option.getOrThrowWith(Schema.decodeUnknownOption(Page)(body), unsupportedCatalog);
      },
      catch: geminiFailure,
    });

  const load = (token: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const entries: Array<unknown> = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;

      for (let count = 0; count < maxPages; count++) {
        const value = yield* page(token, pageToken);
        entries.push(...(value.models ?? []));

        if (value.nextPageToken === undefined || value.nextPageToken === "") {
          const models = entries.flatMap((entry) => {
            const model = Schema.decodeUnknownOption(CatalogModel)(entry);

            return Option.isSome(model)
              ? [{ id: model.value.name.slice("models/".length), model: model.value }]
              : [];
          });

          return models.length === 0 && entries.length > 0
            ? yield* Effect.fail(unsupportedCatalog())
            : models.filter(supportsChat);
        }

        if (seen.has(value.nextPageToken)) {
          break;
        }

        seen.add(value.nextPageToken);
        pageToken = value.nextPageToken;
      }

      return yield* Effect.fail(unsupportedCatalog());
    }).pipe((loading) =>
      Effect.flatMap(timeout("modelCatalogSeconds"), (duration) =>
        loading.pipe(
          Effect.timeoutOrElse({
            duration,
            orElse: () =>
              Effect.fail(
                new ProviderError({
                  provider: "gemini",
                  reason: "temporary",
                  message: "Gemini model discovery timed out.",
                }),
              ),
          }),
        ),
      ),
    );

  const readCatalog = (requested?: string) =>
    Effect.gen(function* () {
      const token = yield* key;
      const hash = createHash("sha256").update(Redacted.value(token)).digest("hex");

      return yield* catalogCache({ http, key: `${baseUrl}\0${hash}`, load: load(token) })(
        requested,
      );
    });

  return {
    id: "gemini",
    models: readCatalog().pipe(Effect.map((entries) => entries.map(describeModel))),
    resolve: (modelId) =>
      Effect.gen(function* () {
        const selected = (yield* readCatalog(modelId)).find((entry) => entry.id === modelId);

        if (!selected) {
          return yield* Effect.fail(
            invalidRequest(
              "gemini",
              "Choose a Gemini model ID from the Gemini catalog. No model fallback is allowed.",
            ),
          );
        }

        return geminiModel(describeModel(selected), {
          key,
          http,
          baseUrl,
          thinking: selected.model.thinking === true,
        });
      }),
  };
};

export const { registration: gemini } = apiKeyProvider({
  id: "gemini",
  name: "Gemini",
  environment: "POPPET_GEMINI_API_KEY",
  make: (key) => makeGeminiProvider(key),
});
