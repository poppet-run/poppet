import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, ModelResolver } from "@poppet/agent";
import { AppConfig, type Settings } from "@poppet/config";
import {
  Provider,
  ProviderConnection,
  ProviderEnvironment,
  ProviderError,
  type ProviderRegistration,
  completeModel,
  type ModelOperations,
  type ProviderId,
} from "@poppet/provider";
import { Store } from "@poppet/store";
import { WorkerConnections } from "@poppet/tasks";
import { ConfigProvider, Context, Effect, Layer, Stream } from "effect";

import { runtimeLayers } from "#src/runtime";

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

const register = (id: ProviderId, provider: Layer.Layer<Provider>): ProviderRegistration => ({
  id,
  name: id,
  authentication: { apiKey: false, help: "Test connection" },
  layer: Layer.merge(
    provider,
    Layer.succeed(ProviderConnection, {
      login: () => Effect.succeed("Connected"),
      status: Effect.succeed({ connected: false }),
      logout: Effect.succeed("Disconnected"),
      verify: () => Effect.succeed("selected-model"),
    }),
  ),
});

describe("runtimeLayers", () => {
  test.each(["first-provider", "second-provider"] as const)(
    "when %s is selected, builds only that provider and resolves the explicit model",
    async (selected) => {
      const built: ProviderId[] = [];
      const closed: ProviderId[] = [];
      const resolved: string[] = [];

      const layer = (id: ProviderId) =>
        Layer.effect(
          Provider,
          Effect.acquireRelease(
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
            () =>
              Effect.sync(() => {
                closed.push(id);
              }),
          ),
        );

      const runtime = runtimeLayers(
        ["first-provider", "second-provider"].map((id) => register(id, layer(id))),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const model = yield* runtime.resolveModel;
          expect(closed).toEqual([]);

          return yield* completeModel(model, {
            sessionId: "fake-session",
            workload: "assistant",
            instructions: "",
            messages: [{ role: "user", text: "Hello" }],
            tools: [],
            settings: {},
          });
        }).pipe(Effect.provideService(AppConfig, { ...config, provider: selected }), Effect.scoped),
      );

      expect(built).toEqual([selected]);
      expect(closed).toEqual([selected]);
      expect(resolved).toEqual(["selected-model"]);
      expect(result.output).toEqual([{ type: "text", text: "fake model answer" }]);
    },
  );

  test("when no model is selected, fails before discovery or inference", async () => {
    const runtime = runtimeLayers([
      register("openai-chatgpt", Layer.effect(Provider, Effect.die("Provider must not be built"))),
    ]);

    await expect(
      Effect.runPromise(
        runtime.resolveModel.pipe(
          Effect.provideService(AppConfig, { ...config, model: null }),
          Effect.scoped,
        ),
      ),
    ).rejects.toMatchObject({ reason: "invalid-request" });
  });

  test.each(["other-provider", "other-model"])(
    "when resolution returns %s, rejects the mismatched selection",
    async (mismatch) => {
      const selected = fakeModel(
        mismatch === "other-provider" ? "opencode-go" : "openai-chatgpt",
        mismatch === "other-model" ? "different-model" : "selected-model",
      );

      const runtime = runtimeLayers([
        register(
          "openai-chatgpt",
          Layer.succeed(Provider, {
            id: "openai-chatgpt",
            models: Effect.succeed([]),
            resolve: () => Effect.succeed(selected),
          }),
        ),
      ]);

      await expect(
        Effect.runPromise(
          runtime.resolveModel.pipe(Effect.provideService(AppConfig, config), Effect.scoped),
        ),
      ).rejects.toMatchObject({
        reason: "invalid-request",
        message: "The provider resolved a different model. No fallback is allowed.",
      });
    },
  );

  test("when the configuration file changes, running services retain their startup settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-runtime-config-"));

    const configuration = ConfigProvider.fromEnv({
      env: { POPPET_DATA_DIR: directory },
      preserveEmptyStrings: true,
    });

    const id = "test-provider";

    const runtime = runtimeLayers([
      {
        id,
        name: "Test",
        authentication: { apiKey: false, help: "Test" },
        layer: Layer.effectContext(
          Effect.gen(function* () {
            expect((yield* ProviderEnvironment).applicationName).toBe("Startup name");

            return Context.make(Provider, {
              id,
              models: Effect.succeed([]),
              resolve: () => Effect.succeed(fakeModel(id, "test-model")),
            }).pipe(
              Context.add(ProviderConnection, {
                login: () => Effect.succeed("Connected"),
                logout: Effect.succeed("Disconnected"),
                verify: () => Effect.succeed("test-model"),
                status: Effect.succeed({ connected: true }),
              }),
            );
          }),
        ),
      },
    ]);

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({ applicationName: "Startup name" }),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* (yield* Store).createSession(id, "test-model");
            yield* Effect.promise(() => writeFile(join(directory, "config.json"), "invalid JSON"));
            yield* Stream.runDrain((yield* Agent).send(session.id, "Hello"));
            expect(yield* (yield* WorkerConnections).status(id)).toMatchObject({ connected: true });
          }),
        ).pipe(
          Effect.provide(runtime.chat),
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when worker connection status is requested, redacts secrets and reports actions and cached metadata", async () => {
    const id = "test-provider";
    let busy = false;
    let connected = true;

    const layer = Layer.unwrap(
      Effect.sync(() =>
        busy
          ? Layer.effect(
              ProviderConnection,
              Effect.fail(
                new ProviderError({
                  provider: id,
                  reason: "authentication",
                  code: "credential_store_busy",
                  message: "busy",
                }),
              ),
            )
          : Layer.succeed(ProviderConnection, {
              login: () => Effect.succeed("connected"),
              logout: Effect.succeed("disconnected"),
              verify: () => Effect.succeed("model"),
              status: Effect.sync(() => ({
                connected,
                email: "person@example.com",
                planUsage: false,
                apiKey: "must-not-appear",
              })),
            }),
      ),
    );

    const runtime = runtimeLayers([
      {
        id,
        name: "Test",
        authentication: { apiKey: false, help: "Test" },
        layer: Layer.merge(
          layer,
          Layer.succeed(Provider, {
            id,
            models: Effect.succeed([]),
            resolve: () => Effect.succeed(fakeModel(id, "model")),
          }),
        ),
      },
    ]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkerConnections;
        const first = yield* service.status(id);
        expect(first).toMatchObject({
          account: "person@example.com",
          planUsage: false,
          cached: false,
          action: `Run provider login ${id}.`,
        });
        expect(JSON.stringify(first)).not.toContain("must-not-appear");
        busy = true;
        expect(yield* service.status(id)).toMatchObject({
          account: "person@example.com",
          cached: true,
          observedAt: first.observedAt,
        });
        busy = false;
        connected = false;
        expect(yield* service.status(id)).toMatchObject({
          connected: false,
          cached: false,
          action: `Run provider login ${id}.`,
        });
      }).pipe(Effect.provide(runtime.connections)),
    );
  });

  test("when model resolution and status share a runtime, reuses connection metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-runtime-status-"));

    const configuration = ConfigProvider.fromEnv({
      env: { POPPET_DATA_DIR: directory },
      preserveEmptyStrings: true,
    });

    const id = "test-provider";
    let busy = false;

    const registered: ReadonlyArray<ProviderRegistration> = [
      {
        id,
        name: "Test",
        authentication: { apiKey: false, help: "Test" },
        layer: Layer.merge(
          Layer.succeed(Provider, {
            id,
            models: Effect.succeed([]),
            resolve: () => Effect.succeed(fakeModel(id, "test-model")),
          }),
          Layer.unwrap(
            Effect.sync(() =>
              busy
                ? Layer.effect(
                    ProviderConnection,
                    Effect.fail(
                      new ProviderError({
                        provider: id,
                        reason: "authentication",
                        code: "credential_store_busy",
                        message: "busy",
                      }),
                    ),
                  )
                : Layer.succeed(ProviderConnection, {
                    login: () => Effect.succeed("Connected"),
                    logout: Effect.succeed("Disconnected"),
                    verify: () => Effect.succeed("test-model"),
                    status: Effect.succeed({ connected: true, email: "resolved@example.com" }),
                  }),
            ),
          ),
        ),
      },
    ];

    const runtime = runtimeLayers(registered);

    try {
      await Effect.runPromise(
        ModelResolver.use((resolver) => resolver.resolve(id, "test-model")).pipe(
          Effect.scoped,
          Effect.provide(runtime.chat),
          Effect.provideService(ConfigProvider.ConfigProvider, configuration),
        ),
      );
      busy = true;

      const status = WorkerConnections.use((connections) => connections.status(id));
      expect(
        await Effect.runPromise(
          status.pipe(
            Effect.provide(runtime.connections),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          ),
        ),
      ).toMatchObject({
        provider: id,
        account: "resolved@example.com",
        connected: true,
        cached: true,
      });

      const independent = runtimeLayers(registered);
      expect(
        await Effect.runPromise(
          status.pipe(
            Effect.provide(independent.connections),
            Effect.provideService(ConfigProvider.ConfigProvider, configuration),
          ),
        ),
      ).toMatchObject({
        connected: null,
        account: null,
        action: "Authentication is busy. Check again after the active run finishes.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
