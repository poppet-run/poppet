import { randomBytes } from "node:crypto";

import { Context, Effect, Layer, Redacted, Schema } from "effect";
import OpenAI, { APIError } from "openai";
import type {
  Response as ModelResponse,
  ResponseInput,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";

import { ChatGPTAuth } from "./auth.ts";
import { ConnectionError, requestFailure, resource } from "./connection.ts";
import type { HttpFetch } from "./oauth.ts";

const ModelCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
    }),
  ),
});

export type AvailableModel = (typeof ModelCatalog.Type.models)[number];

const ToolArguments = Schema.fromJsonString(Schema.Struct({ challenge: Schema.NonEmptyString }));

interface ModelOperations {
  readonly models: Effect.Effect<ReadonlyArray<AvailableModel>, ConnectionError>;
  readonly verify: (model: string | null) => Effect.Effect<string, ConnectionError>;
}

export class ChatGPTModel extends Context.Service<ChatGPTModel, ModelOperations>()(
  "poppet/ChatGPTModel",
) {}

const modelFailure = (cause: unknown): ConnectionError => {
  if (cause instanceof ConnectionError) return cause;

  if (cause instanceof APIError)
    return requestFailure(cause.status ?? 0, cause.code, cause.requestID);

  return new ConnectionError({
    reason: "temporary",
    message: "The OpenAI request could not complete. No automatic retry was attempted.",
  });
};

const complete = (client: OpenAI, request: ResponseCreateParamsStreaming) =>
  Effect.tryPromise({
    try: async (signal) => {
      const stream = await client.responses.create(request, { signal });
      let response: ModelResponse | null = null;
      const completedItems = new Map<number, ModelResponse["output"][number]>();

      for await (const event of stream) {
        if (event.type === "response.output_item.done")
          completedItems.set(event.output_index, event.item);

        if (event.type === "response.completed") response = event.response;

        if (event.type === "response.failed")
          throw requestFailure(0, event.response.error?.code ?? null);

        if (event.type === "response.incomplete")
          throw new ConnectionError({
            reason: "interrupted",
            message: "OpenAI reported an incomplete response. Verification did not pass.",
          });

        if (event.type === "error") throw requestFailure(0, event.code);
      }

      if (!response || response.status !== "completed")
        throw new ConnectionError({
          reason: "interrupted",
          message: "The stream ended without completed inference. Verification did not pass.",
        });

      for (const [index, item] of response.output.entries()) {
        if (!completedItems.has(index)) completedItems.set(index, item);
      }

      return {
        ...response,
        output: [...completedItems.entries()]
          .toSorted(([left], [right]) => left - right)
          .map(([, item]) => item),
      };
    },
    catch: modelFailure,
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ConnectionError({
          reason: "interrupted",
          message: "The inference deadline expired. Verification did not pass.",
        }),
      ),
    ),
  );

const clientFor = (token: Redacted.Redacted<string>, http: HttpFetch) =>
  new OpenAI({
    apiKey: Redacted.value(token),
    baseURL: resource,
    maxRetries: 0,
    timeout: 45_000,
    fetch: http,
  });

export const makeChatGPTModel = (http: HttpFetch = fetch) =>
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;

    const models = Effect.gen(function* () {
      const token = yield* auth.accessToken;

      const body = yield* Effect.tryPromise({
        try: (signal) => clientFor(token, http).get("/models", { signal }),
        catch: modelFailure,
      });

      const catalog = yield* Schema.decodeUnknownEffect(ModelCatalog)(body).pipe(
        Effect.mapError(
          () =>
            new ConnectionError({
              reason: "unsupported",
              message: "OpenAI returned an unsupported model catalog.",
            }),
        ),
      );

      return catalog.models.filter((model) => model.visibility === "list");
    });

    const verify = (requestedModel: string | null) =>
      Effect.gen(function* () {
        const catalog = yield* models;
        const model = requestedModel ?? catalog[0]?.slug;

        if (!model || !catalog.some((entry) => entry.slug === model))
          return yield* Effect.fail(
            new ConnectionError({
              reason: "unsupported",
              message: "Choose a model from bun run start auth models.",
            }),
          );
        const token = yield* auth.accessToken;
        const client = clientFor(token, http);
        const challenge = randomBytes(24).toString("hex");
        const proof = `poppet_verified_${randomBytes(24).toString("hex")}`;

        const input: ResponseInput = [
          {
            role: "user",
            content: `Call get_verification_token with challenge ${challenge}, then return only its token.`,
          },
        ];

        const tools: ResponseCreateParamsStreaming["tools"] = [
          {
            type: "namespace",
            name: "poppet_verification",
            description: "Local Poppet subscription verification.",
            tools: [
              {
                type: "function",
                name: "get_verification_token",
                description: "Return a local token for the supplied verification challenge.",
                strict: true,
                parameters: {
                  type: "object",
                  properties: { challenge: { type: "string" } },
                  required: ["challenge"],
                  additionalProperties: false,
                },
              },
            ],
          },
        ];

        const first = yield* complete(client, {
          model,
          input,
          instructions: "Use the verification tool exactly once. Return its token verbatim.",
          tools,
          tool_choice: "required",
          store: false,
          stream: true,
        });

        const calls = first.output.flatMap((item) => (item.type === "function_call" ? [item] : []));
        const call = calls[0];

        if (
          calls.length !== 1 ||
          !call ||
          call.name !== "get_verification_token" ||
          call.namespace !== "poppet_verification"
        )
          return yield* Effect.fail(
            new ConnectionError({
              reason: "verification",
              message: `The model did not request the expected verification tool exactly once. Received ${calls.length} function calls: ${JSON.stringify(calls.slice(0, 5).map((item) => ({ name: item.name, namespace: item.namespace ?? null })))}. Output types: ${JSON.stringify(first.output.slice(0, 5).map((item) => item.type))}.`,
            }),
          );

        const args = yield* Schema.decodeUnknownEffect(ToolArguments, {
          onExcessProperty: "error",
        })(call.arguments).pipe(
          Effect.mapError(
            () =>
              new ConnectionError({
                reason: "verification",
                message: "The verification tool arguments were invalid.",
              }),
          ),
        );

        if (args.challenge !== challenge)
          return yield* Effect.fail(
            new ConnectionError({
              reason: "verification",
              message: "The verification challenge did not match.",
            }),
          );
        const history: ResponseInput = [];

        for (const item of first.output) {
          if (item.type === "message" || item.type === "reasoning" || item.type === "function_call")
            history.push(item);
          else
            return yield* Effect.fail(
              new ConnectionError({
                reason: "verification",
                message: "The verification response contained unsupported output.",
              }),
            );
        }

        const second = yield* complete(client, {
          model,
          input: [
            ...input,
            ...history,
            {
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify({ token: proof }),
            },
          ],
          instructions: "Return only the token supplied by the verification tool.",
          tools,
          tool_choice: "none",
          store: false,
          stream: true,
        });

        const text = second.output
          .flatMap((item) =>
            item.type === "message"
              ? item.content.flatMap((content) =>
                  content.type === "output_text" ? [content.text] : [],
                )
              : [],
          )
          .join("");

        if (
          text.trim() !== proof ||
          second.output.some((item) => item.type !== "message" && item.type !== "reasoning")
        )
          return yield* Effect.fail(
            new ConnectionError({
              reason: "verification",
              message: "The model did not return the verification tool's token.",
            }),
          );
        yield* auth.recordVerification(model);

        return model;
      });

    return { models, verify } satisfies ModelOperations;
  });

export const ChatGPTModelLive = Layer.effect(ChatGPTModel, makeChatGPTModel());
