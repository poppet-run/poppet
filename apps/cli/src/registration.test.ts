import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Provider,
  ProviderConnection,
  ProviderEnvironment,
  completeModel,
  invalidRequest,
  verifyModel,
  type Completion,
  type ModelOperations,
  type ProviderOperations,
  type ProviderRegistration,
} from "@poppet/provider";
import { Store } from "@poppet/store";
import { Console, Effect, Layer, Stream } from "effect";

import { makeCLI } from "#src/cli";
import { runtimeLayers } from "#src/runtime";

const exampleProvider = () => {
  const id = "example-provider";
  const state = { connected: false, built: 0, verified: 0 };

  const model: ModelOperations = {
    description: {
      provider: id,
      id: "example-model",
      name: "Example model",
      capabilities: {
        tools: true,
        generationSettings: [],
        contextWindow: null,
        maxOutputTokens: null,
      },
    },
    stream: (request) => {
      const serialized = JSON.stringify(request);
      const proof = serialized.match(/poppet_verified_[a-f0-9]+/)?.[0];
      const tool = request.tools[0];

      const response: Completion = {
        output:
          proof || !tool
            ? [{ type: "text", text: proof ?? "Example answer" }]
            : [
                {
                  type: "tool-call",
                  callId: "example-call",
                  name: tool.name,
                  namespace: tool.namespace,
                  arguments: JSON.stringify({
                    challenge: serialized.match(/challenge ([a-f0-9]+)/)?.[1],
                  }),
                },
              ],
        continuation: {
          version: 1,
          provider: id,
          model: "example-model",
          data: { exampleState: "opaque-continuation" },
        },
        finishReason: proof || !tool ? "stop" : "tool-calls",
        usage: null,
      };

      return Stream.make({ type: "completed", response });
    },
  };

  const provider: ProviderOperations = {
    id,
    models: Effect.succeed([model.description]),
    resolve: (modelId) =>
      modelId === model.description.id
        ? Effect.succeed(model)
        : Effect.fail(invalidRequest(id, "Unknown example model.")),
  };

  const inference = Layer.effect(
    Provider,
    Effect.gen(function* () {
      const environment = yield* ProviderEnvironment;
      expect(environment.applicationName).toBe("Registration test");
      state.built++;

      return provider;
    }),
  );

  const connection = Layer.succeed(ProviderConnection, {
    login: () =>
      Effect.sync(() => {
        state.connected = true;

        return "Example login complete.";
      }),
    status: Effect.sync(() => ({ connected: state.connected, provider: id })),
    logout: Effect.sync(() => {
      state.connected = false;

      return "Example logout complete.";
    }),
    verify: (modelId) =>
      Effect.gen(function* () {
        const selected = yield* provider.resolve(modelId ?? "example-model");
        yield* verifyModel(selected);
        state.verified++;

        return selected.description.id;
      }),
  });

  const registration: ProviderRegistration = {
    id,
    name: "Example provider",
    authentication: { consent: false, apiKey: false, help: "Example connection flow." },
    layer: Layer.merge(inference, connection),
  };

  return { registration, state };
};

// This entry must never be built when the appended provider is selected.
const unusedProvider: ProviderRegistration = {
  id: "unused-provider",
  name: "Unused provider",
  authentication: { consent: false, apiKey: false, help: "Unused connection." },
  layer: Layer.merge(
    Layer.effect(Provider, Effect.die("The unselected provider was built.")),
    Layer.effect(ProviderConnection, Effect.die("The unselected connection was built.")),
  ),
};

describe("provider registration", () => {
  test("an appended provider supports configuration, help, auth, inference and persisted continuation through the generic interfaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-registration-"));

    const environment = {
      POPPET_APP_NAME: "Registration test",
      POPPET_PROVIDER: "example-provider",
      POPPET_MODEL: "example-model",
      POPPET_DATA_DIR: directory,
      POPPET_NOTES_DIR: join(directory, "notes"),
    };

    const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const example = exampleProvider();
    const registered = [unusedProvider, example.registration];
    const cli = makeCLI(registered);
    const lines: string[] = [];

    const output: Console.Console = {
      ...console,
      log: (...values) => lines.push(values.join(" ")),
    };

    const invoke = (args: ReadonlyArray<string>) =>
      Effect.runPromise(cli(args).pipe(Effect.provideService(Console.Console, output)));

    try {
      await invoke(["--help"]);
      expect(lines.at(-1)).toContain("example-provider");
      expect(lines.at(-1)).toContain("Example connection flow.");
      await invoke(["config"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({
        provider: "example-provider",
        model: "example-model",
      });
      expect(example.state.built).toBe(0);

      await invoke(["auth", "status"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ connected: false });
      await invoke(["auth", "login", "--provider", "example-provider"]);
      expect(lines.at(-1)).toBe("Example login complete.");
      await invoke(["auth", "status"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ connected: true });
      await invoke(["auth", "models"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toEqual([
        expect.objectContaining({ id: "example-model", provider: "example-provider" }),
      ]);
      await invoke(["provider", "models"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toEqual([
        expect.objectContaining({ id: "example-model", provider: "example-provider" }),
      ]);
      await invoke(["auth", "verify"]);
      expect(example.state.verified).toBe(1);
      await invoke(["provider", "verify"]);
      expect(lines.at(-1)).toContain("example-provider/example-model");

      const built = example.state.built;
      await expect(invoke(["auth", "status", "unregistered-provider"])).rejects.toMatchObject({
        reason: "invalid-request",
      });
      await expect(invoke(["auth", "login", "--consent"])).rejects.toMatchObject({
        message: expect.stringContaining("does not support --consent"),
      });
      await expect(invoke(["auth", "login", "--key-stdin"])).rejects.toMatchObject({
        message: expect.stringContaining("does not support --key-stdin"),
      });
      expect(example.state.built).toBe(built);
      await invoke(["auth", "logout"]);
      await invoke(["auth", "status"]);
      expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ connected: false });

      const runtime = runtimeLayers(registered);

      const session = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const created = yield* store.createSession("example-provider", "example-model");
          const run = yield* store.queueRun(created.id, [{ role: "user", text: "Example input" }]);
          yield* store.startRun(run.id);
          const model = yield* (yield* Provider).resolve("example-model");

          const response = yield* completeModel(model, {
            sessionId: created.id,
            workload: "assistant",
            instructions: "",
            messages: [{ role: "user", text: "Example input" }],
            tools: [],
            settings: {},
          });

          yield* store.finishRun(run.id, { status: "completed", response });

          return created;
        }).pipe(Effect.provide(Layer.merge(runtime.store, runtime.provider))),
      );

      const reopened = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;

          return {
            session: yield* store.session(session.id),
            messages: yield* store.messages(session.id),
          };
        }).pipe(Effect.provide(runtime.store)),
      );

      expect(reopened.session).toMatchObject({
        provider: "example-provider",
        model: "example-model",
      });
      expect(reopened.messages.at(-1)?.message).toMatchObject({
        continuation: {
          provider: "example-provider",
          data: { exampleState: "opaque-continuation" },
        },
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });
});
