import { loadApiKey as storedApiKey } from "@poppet/credentials";
import {
  Provider,
  ProviderError,
  invalidRequest,
  type ModelDescription,
  type ModelOperations,
  type ProviderOperations,
} from "@poppet/provider";
import {
  inferenceFailure,
  chatCompletionsModel,
  responsesModel,
} from "@poppet/provider-openai/protocol";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import OpenAI, { APIError } from "openai";

export type HttpFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const userAgent = "poppet/0.0.0";

const Catalog = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) });

// Expand this list only after the model's protocol and continuation are tested.
const supportedModels: ReadonlyArray<ModelDescription> = [
  {
    provider: "opencode-go",
    id: "gpt-6-luna",
    name: "GPT 6 Luna",
    protocol: "responses",
    capabilities: {
      tools: true,
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
      generationSettings: ["temperature", "maxOutputTokens"],
      contextWindow: null,
      maxOutputTokens: null,
    },
  },
];

export const loadApiKey = storedApiKey("opencode-go");

export const makeOpenCodeProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError> = loadApiKey,
  http: HttpFetch = fetch,
  baseUrl = "https://opencode.ai/inference/go/v1",
): ProviderOperations => {
  const models = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => http(`${baseUrl}/models`, { signal, headers: { "User-Agent": userAgent } }),
      catch: (cause) => inferenceFailure("opencode-go", cause),
    });

    if (!response.ok) {
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());

      return yield* Effect.fail(
        inferenceFailure(
          "opencode-go",
          new APIError(response.status, undefined, undefined, response.headers),
        ),
      );
    }

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => invalidRequest("opencode-go", "OpenCode Go returned an invalid model catalog."),
    });

    const catalog = yield* Schema.decodeUnknownEffect(Catalog)(body).pipe(
      Effect.mapError(() =>
        invalidRequest("opencode-go", "OpenCode Go returned an unsupported model catalog."),
      ),
    );

    return supportedModels.filter((model) => catalog.data.some((entry) => entry.id === model.id));
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProviderError({
          provider: "opencode-go",
          reason: "temporary",
          message: "OpenCode Go model discovery timed out.",
        }),
      ),
    ),
  );

  const resolve = (modelId: string) =>
    Effect.gen(function* () {
      if (!supportedModels.some((model) => model.id === modelId))
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
        Effect.map(
          (token) =>
            new OpenAI({
              apiKey: Redacted.value(token),
              baseURL: baseUrl,
              fetch: http,
              maxRetries: 0,
              logLevel: "off",
              timeout: 45_000,
              defaultHeaders: { "User-Agent": userAgent },
            }),
        ),
      );

      const model =
        description.protocol === "responses"
          ? responsesModel(description, client)
          : chatCompletionsModel(description, client);

      return {
        description,
        stream: (request) =>
          request.workload === "coding"
            ? model.stream(request)
            : Stream.fail(
                new ProviderError({
                  provider: "opencode-go",
                  reason: "permission",
                  message:
                    "OpenCode Go requires coding-agent workloads. General assistant and notes tasks are not enabled.",
                }),
              ),
      } satisfies ModelOperations;
    });

  return { id: "opencode-go", models, resolve };
};

export const OpenCodeGoLive = Layer.succeed(Provider, makeOpenCodeProvider());
