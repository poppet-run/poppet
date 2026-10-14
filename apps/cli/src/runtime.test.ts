import { describe, expect, test } from "bun:test";

import { AppConfig, type Settings } from "@poppet/config";
import {
  Model,
  Provider,
  ProviderConnection,
  ProviderEnvironment,
  type ProviderRegistration,
  completeModel,
  type ModelOperations,
  type ProviderId,
} from "@poppet/provider";
import { Effect, Layer, Stream } from "effect";

import { resolveConfiguredModel, selectProviderLayer } from "#src/runtime";

const config: Settings = {
  applicationName: "Test",
  dataDirectory: "/unused",
  notesDirectory: "/unused/notes",
  provider: "openai-chatgpt",
  model: "selected-model",
};

const fakeModel = (provider: ProviderId, id: string): ModelOperations => ({
  description: {
    provider,
    id,
    name: id,
    capabilities: {
      tools: true,
      generationSettings: [],
      contextWindow: null,
      maxOutputTokens: null,
    },
  },
  stream: () =>
    Stream.make({
      type: "completed",
      response: {
        output: [{ type: "text", text: "fake model answer" }],
        finishReason: "stop",
        usage: null,
        continuation: { version: 1, provider, model: id, data: {} },
      },
    }),
});

describe("configured model runtime", () => {
  test.each(["first-provider", "second-provider", "new-provider"] as const)(
    "builds only %s and resolves the explicit model",
    async (selected) => {
      const built: ProviderId[] = [];
      const resolved: string[] = [];

      const layer = (id: ProviderId) =>
        Layer.effect(
          Provider,
          Effect.sync(() => {
            built.push(id);

            return {
              id,
              models: Effect.succeed([fakeModel(id, "selected-model").description]),
              resolve: (model: string) =>
                Effect.sync(() => {
                  resolved.push(model);

                  return fakeModel(id, model);
                }),
            };
          }),
        );

      const runtime = Layer.effect(Model, resolveConfiguredModel).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AppConfig, { ...config, provider: selected }),
            selectProviderLayer(
              selected,
              ["first-provider", "second-provider", "new-provider"].map(
                (id): ProviderRegistration => ({
                  id,
                  name: id,
                  authentication: { consent: false, apiKey: false, help: "Test connection" },
                  layer: Layer.merge(
                    layer(id),
                    Layer.succeed(ProviderConnection, {
                      login: () => Effect.succeed("Connected"),
                      status: Effect.succeed({ connected: false }),
                      logout: Effect.succeed("Disconnected"),
                      verify: () => Effect.succeed("selected-model"),
                    }),
                  ),
                }),
              ),
            ).pipe(
              Layer.provide(
                Layer.succeed(ProviderEnvironment, {
                  applicationName: "Test",
                  dataDirectory: "/unused",
                }),
              ),
            ),
          ),
        ),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const model = yield* Model;

          return yield* completeModel(model, {
            sessionId: "fake-session",
            workload: "assistant",
            instructions: "",
            messages: [{ role: "user", text: "Hello" }],
            tools: [],
            settings: {},
          });
        }).pipe(Effect.provide(runtime)),
      );

      expect(built).toEqual([selected]);
      expect(resolved).toEqual(["selected-model"]);
      expect(result.output).toEqual([{ type: "text", text: "fake model answer" }]);
    },
  );

  test("requires an explicit model before discovery or inference", async () => {
    await expect(
      Effect.runPromise(
        resolveConfiguredModel.pipe(
          Effect.provideService(AppConfig, { ...config, model: null }),
          Effect.provideService(Provider, {
            id: "openai-chatgpt",
            models: Effect.die("Discovery must not run"),
            resolve: () => Effect.die("Resolution must not run"),
          }),
        ),
      ),
    ).rejects.toMatchObject({ reason: "invalid-request" });
  });

  test.each(["other-provider", "other-model"])(
    "rejects resolution to %s instead of the configured selection",
    async (mismatch) => {
      const selected = fakeModel(
        mismatch === "other-provider" ? "opencode-go" : "openai-chatgpt",
        mismatch === "other-model" ? "different-model" : "selected-model",
      );

      await expect(
        Effect.runPromise(
          resolveConfiguredModel.pipe(
            Effect.provideService(AppConfig, config),
            Effect.provideService(Provider, {
              id: "openai-chatgpt",
              models: Effect.succeed([]),
              resolve: () => Effect.succeed(selected),
            }),
          ),
        ),
      ).rejects.toMatchObject({
        reason: "invalid-request",
        message: "The provider resolved a different model. No fallback is allowed.",
      });
    },
  );
});
