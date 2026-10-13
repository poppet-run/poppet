import { randomBytes, randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";

import type { ModelRequest, Tool } from "#src/schema";
import { completeModel, invalidRequest, type ModelOperations } from "#src/service";

const Arguments = Schema.fromJsonString(Schema.Struct({ challenge: Schema.NonEmptyString }));

export const verifyModel = (model: ModelOperations) =>
  Effect.gen(function* () {
    const challenge = randomBytes(24).toString("hex");
    const proof = `poppet_verified_${randomBytes(24).toString("hex")}`;

    const tool: Tool = {
      name: "get_verification_token",
      namespace: "poppet_verification",
      description: "Return a local token for the supplied coding-tool verification challenge.",
      parameters: {
        type: "object",
        properties: { challenge: { type: "string" } },
        required: ["challenge"],
        additionalProperties: false,
      },
    };

    const request: ModelRequest = {
      sessionId: randomUUID(),
      workload: "coding",
      instructions: "Verify the local coding tool exactly once. Return its token verbatim.",
      messages: [
        {
          role: "user",
          text: `Call get_verification_token with challenge ${challenge}, then return only its token.`,
        },
      ],
      tools: [tool],
      settings: { toolChoice: "required" },
    };

    const first = yield* completeModel(model, request);
    const calls = first.output.flatMap((item) => (item.type === "tool-call" ? [item] : []));
    const call = calls[0];

    if (calls.length !== 1 || !call || call.name !== tool.name || call.namespace !== tool.namespace)
      return yield* Effect.fail(
        invalidRequest(
          model.description.provider,
          "The model did not request the verification tool exactly once.",
        ),
      );

    const args = yield* Schema.decodeUnknownEffect(Arguments, { onExcessProperty: "error" })(
      call.arguments,
    ).pipe(
      Effect.mapError(() =>
        invalidRequest(model.description.provider, "The verification tool arguments were invalid."),
      ),
    );

    if (args.challenge !== challenge)
      return yield* Effect.fail(
        invalidRequest(model.description.provider, "The verification challenge did not match."),
      );

    const second = yield* completeModel(model, {
      ...request,
      instructions: "Return only the token supplied by the verification tool.",
      messages: [
        ...request.messages,
        { role: "assistant", output: first.output, continuation: first.continuation },
        { role: "tool", callId: call.callId, output: JSON.stringify({ token: proof }) },
      ],
      settings: { toolChoice: "none" },
    });

    const text = second.output
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("");

    if (text.trim() !== proof || second.output.some((item) => item.type === "tool-call"))
      return yield* Effect.fail(
        invalidRequest(
          model.description.provider,
          "The model did not return the verification tool's token.",
        ),
      );
  });
