import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import type { ModelEvent, ModelOperations, ModelRequest } from "@poppet/provider";
import { StoreLive } from "@poppet/store";
import { Deferred, Effect, Layer, Stream, type Context } from "effect";

import { Pages } from "#src/pages";
import { AgentLive, ModelResolver } from "#src/service";
import { ChatSettings, defaultPolicy, type ChatPolicy } from "#src/settings";
import { WebSearch } from "#src/web-search";

/** Provides a service only when a test supplies one. */
export const optionalService = <I, S>(tag: Context.Key<I, S>, value: S | undefined) =>
  value === undefined ? Layer.empty : Layer.succeed(tag, value);

/** The request ends with a tool error, which a model would answer rather than call again. */
export const reportedError = (request: ModelRequest) => {
  const last = request.messages.at(-1);

  return last?.role === "tool" && last.output.startsWith('{"error":');
};

/** The configured test model; it records requests and answers reported tool errors with `answer`. */
export const testModel = (options: {
  readonly stream: ModelOperations["stream"];
  readonly answer: ModelOperations["stream"];
  readonly requests?: ModelRequest[];
  readonly capabilities?: Partial<ModelOperations["description"]["capabilities"]>;
}): ModelOperations => ({
  description: {
    provider: "test-provider",
    id: "test-model",
    name: "Test",
    capabilities: {
      tools: true,
      images: false,
      generationSettings: [],
      contextWindow: null,
      maxOutputTokens: null,
      ...options.capabilities,
    },
  },
  stream: (request) => {
    options.requests?.push(request);

    return reportedError(request) ? options.answer(request) : options.stream(request);
  },
});

/**
 * A model stream whose answer to each prompt waits until the test releases that prompt's gate.
 * `entered` completes when the model receives the prompt.
 */
export const gatedStream = (answer: (prompt: string) => Stream.Stream<ModelEvent>) => {
  const gates = new Map<
    string,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();

  const gate = (prompt: string) => {
    const existing = gates.get(prompt);

    if (existing !== undefined) return existing;
    const created = { entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() };
    gates.set(prompt, created);

    return created;
  };

  const stream: ModelOperations["stream"] = (request) => {
    const last = request.messages.at(-1);
    const prompt = last?.role === "user" ? last.text : "";
    const { entered, release } = gate(prompt);

    return Stream.fromEffect(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Stream.flatMap(() => answer(prompt)));
  };

  return { gate, stream };
};

/** A temporary data directory configured for the test model, with a store over it. */
export const agentHarness = async (policy: Partial<ChatPolicy> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-agent-test-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const settings = Layer.succeed(ChatSettings, { ...defaultPolicy, ...policy });

  return {
    directory,
    config,
    store,
    settings,
    /** The agent over this store, without web search or pages; later `services` replace defaults. */
    agent: <const S extends ReadonlyArray<Layer.Layer<never, any, any>>>(
      resolve: ModelResolver["Service"]["resolve"],
      ...services: S
    ) =>
      AgentLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            store,
            LocalMemoryLive.pipe(Layer.provide(store)),
            settings,
            Layer.succeed(WebSearch, { search: null }),
            Layer.succeed(Pages, { fetch: () => Effect.die("Unexpected page fetch") }),
            Layer.succeed(ModelResolver, { resolve }),
            ...services,
          ),
        ),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};
