import {
  ApiKeyStoreLive,
  makeApiKeyConnection,
  loadApiKey as storedApiKey,
} from "@poppet/credentials";
import {
  Provider,
  ProviderEnvironment,
  ProviderConnection,
  ModelDescription,
  type ProviderRegistration,
  ProviderError,
  invalidRequest,
  type ModelOperations,
  type ProviderOperations,
} from "@poppet/provider";
import { inferenceFailure, chatCompletionsModel, responsesModel } from "@poppet/provider-protocol";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import OpenAI, { APIError } from "openai";

import { sessionHeaders, goOptions } from "#src/protocol";

export type HttpFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const userAgent = "poppet/0.0.0";

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

const apiKeyEnvironment = "POPPET_OPENCODE_GO_API_KEY";

export const loadApiKey = storedApiKey("opencode-go", apiKeyEnvironment);

export const makeOpenCodeProvider = (
  key: Effect.Effect<Redacted.Redacted<string>, ProviderError>,
  http: HttpFetch = fetch,
  baseUrl = "https://opencode.ai/inference/go/v1",
): ProviderOperations => {
  const models = Effect.gen(function* () {
    // Keep the response body inside the fetch's cancellation boundary.
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await http(`${baseUrl}/models`, {
          signal,
          headers: { "User-Agent": userAgent },
        });

        if (!response.ok) {
          await response.body?.cancel();
          throw new APIError(response.status, undefined, undefined, response.headers);
        }

        try {
          return await response.json();
        } catch {
          throw invalidRequest("opencode-go", "OpenCode Go returned an invalid model catalog.");
        }
      },
      catch: (cause) => inferenceFailure("opencode-go", cause),
    });

    const catalog = yield* Schema.decodeUnknownEffect(Catalog)(body).pipe(
      Effect.mapError(() =>
        invalidRequest("opencode-go", "OpenCode Go returned an unsupported model catalog."),
      ),
    );

    return supportedModels
      .values()
      .filter((model) => catalog.data.some((entry) => entry.id === model.id))
      .map((model) => Schema.decodeUnknownSync(ModelDescription)(model))
      .toArray();
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
        supported.protocol === "responses"
          ? responsesModel(description, client, { headers: sessionHeaders })
          : chatCompletionsModel(description, client, "max_tokens", goOptions);

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

const inference = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const environment = yield* ProviderEnvironment;

    return makeOpenCodeProvider(
      loadApiKey.pipe(Effect.provideService(ProviderEnvironment, environment)),
    );
  }),
);

export const OpenCodeGoLive = Layer.effect(
  ProviderConnection,
  Provider.use((provider) => makeApiKeyConnection(provider, apiKeyEnvironment)),
).pipe(Layer.provideMerge([inference, ApiKeyStoreLive]));

export const openCodeGo: ProviderRegistration = {
  id: "opencode-go",
  name: "OpenCode Go",
  authentication: {
    consent: false,
    apiKey: true,
    help: "API key from hidden input, --key-stdin, or POPPET_OPENCODE_GO_API_KEY.",
  },
  layer: OpenCodeGoLive,
};
