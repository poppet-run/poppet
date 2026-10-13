import { randomBytes } from "node:crypto";

import { Effect, Schema } from "effect";
import type OpenAI from "openai";
import type {
  ResponseInput,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";

import { ConnectionError } from "../connection.ts";
import { complete } from "./stream.ts";

const ToolArguments = Schema.fromJsonString(Schema.Struct({ challenge: Schema.NonEmptyString }));

export const verifySubscription = (client: OpenAI, model: string) =>
  Effect.gen(function* () {
    // The model knows the challenge, but can only learn this random proof through
    // our tool result. Returning it checks the complete tool round trip.
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
    // Carry the complete first response forward, including encrypted reasoning,
    // so the next request continues the same tool exchange.
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

    // Supply the tool result under the model's call ID. Disable further tool
    // calls so the next response must return the proof we supplied.
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
  });
