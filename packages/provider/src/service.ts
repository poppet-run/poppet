import { Context, Data, Effect, Schema, Stream } from "effect";

import {
  ModelRequest,
  type Completion,
  type ModelDescription,
  type ModelEvent,
  type ProviderId,
} from "#src/schema";

/** A provider failure classified for callers without exposing its wire protocol. */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: ProviderId;
  readonly reason:
    | "authentication"
    | "permission"
    | "quota"
    | "rate-limit"
    | "temporary"
    | "invalid-request"
    | "context-limit"
    | "interrupted";
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
}> {}

/** Inference operations for one resolved provider and model. */
export interface ModelOperations {
  readonly description: ModelDescription;
  /** Starts inference when consumed; emits text deltas followed by one final completion. */
  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ProviderError>;
}

/** Lists and resolves models using the provider's own credentials and protocol. */
export interface ProviderOperations {
  readonly id: ProviderId;
  readonly models: Effect.Effect<ReadonlyArray<ModelDescription>, ProviderError>;
  /** Resolves the requested model or fails; callers must not silently switch models. */
  readonly resolve: (modelId: string) => Effect.Effect<ModelOperations, ProviderError>;
}

/** Supplies the selected provider's model catalogue and resolver. */
export class Provider extends Context.Service<Provider, ProviderOperations>()("poppet/Provider") {}

/** Supplies one resolved model for inference. */
export class Model extends Context.Service<Model, ModelOperations>()("poppet/Model") {}

export const invalidRequest = (provider: ProviderId, message: string) =>
  new ProviderError({ provider, reason: "invalid-request", message });

export const interrupted = (provider: ProviderId, message: string) =>
  new ProviderError({ provider, reason: "interrupted", message });

/** Rejects malformed requests, unsupported settings, and continuation from another model. */
export const validateRequest = (description: ModelDescription, request: ModelRequest) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ModelRequest, { onExcessProperty: "error" })(
      request,
    ).pipe(
      Effect.mapError(() => invalidRequest(description.provider, "The model request is invalid.")),
    );

    if (decoded.tools.length > 0 && !description.capabilities.tools)
      return yield* Effect.fail(
        invalidRequest(description.provider, "This model does not support tools."),
      );

    for (const setting of ["temperature", "maxOutputTokens"] as const) {
      if (
        decoded.settings[setting] !== undefined &&
        !description.capabilities.generationSettings.includes(setting)
      )
        return yield* Effect.fail(
          invalidRequest(description.provider, `This model does not accept ${setting}.`),
        );
    }

    if (
      decoded.settings.maxOutputTokens !== undefined &&
      description.capabilities.maxOutputTokens !== null &&
      decoded.settings.maxOutputTokens > description.capabilities.maxOutputTokens
    )
      return yield* Effect.fail(
        invalidRequest(
          description.provider,
          "The output token limit exceeds this model's capacity.",
        ),
      );

    if (decoded.settings.toolChoice === "required" && decoded.tools.length === 0)
      return yield* Effect.fail(
        invalidRequest(description.provider, "A required tool choice needs at least one tool."),
      );

    const names = new Set<string>();

    for (const tool of decoded.tools) {
      const name = JSON.stringify([tool.namespace, tool.name]);

      if (names.has(name))
        return yield* Effect.fail(
          invalidRequest(description.provider, "Tool names must be unique within a namespace."),
        );
      names.add(name);
    }

    for (const message of decoded.messages) {
      if (message.role !== "assistant" || message.continuation === null) continue;

      if (
        message.continuation.provider !== description.provider ||
        message.continuation.model !== description.id
      )
        return yield* Effect.fail(
          invalidRequest(
            description.provider,
            "Continuation belongs to another provider or model. Start a new session.",
          ),
        );
    }

    return decoded;
  });

/** Collects a model stream and requires exactly one completion as its final event. */
export const completeModel = (model: ModelOperations, request: ModelRequest) =>
  Effect.gen(function* () {
    const events = yield* Stream.runCollect(model.stream(request));
    let response: Completion | null = null;

    for (const [index, event] of events.entries()) {
      if (event.type !== "completed") continue;

      if (response !== null || index !== events.length - 1)
        return yield* Effect.fail(
          interrupted(model.description.provider, "The stream has an invalid completion sequence."),
        );
      response = event.response;
    }

    if (response === null)
      return yield* Effect.fail(
        interrupted(model.description.provider, "The stream ended without completed inference."),
      );

    return response;
  });
