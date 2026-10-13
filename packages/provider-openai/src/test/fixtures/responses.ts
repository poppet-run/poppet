import { Match, Schema } from "effect";

import type { Controls } from "#src/test/fixtures/controls";

const UserInput = Schema.Struct({ role: Schema.Literal("user"), content: Schema.String });

const CallInput = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
  arguments: Schema.String,
});

const ResultInput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String,
});

const ReasoningInput = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.optionalKey(Schema.String),
});

const ModelRequest = Schema.Struct({
  model: Schema.String,
  store: Schema.Boolean,
  stream: Schema.Boolean,
  tool_choice: Schema.String,
  tools: Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String })),
  input: Schema.Array(Schema.Union([UserInput, CallInput, ResultInput, ReasoningInput])),
});

export const makeResponsesProvider = (controls: Controls) => {
  const requests: Array<typeof ModelRequest.Type> = [];
  const bearerHeaders: Array<string | null> = [];

  const handle = async (request: Request) => {
    const url = new URL(request.url);
    bearerHeaders.push(request.headers.get("authorization"));

    if (url.pathname === "/v1/models")
      return Response.json({
        models: [
          { slug: "test-model", display_name: "Test model", visibility: "list" },
          { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
        ],
      });

    if (url.pathname !== "/v1/responses") return new Response(null, { status: 404 });

    const body = Schema.decodeUnknownSync(ModelRequest)(await request.json());
    requests.push(body);

    const result = body.input.find(
      (item) => "type" in item && item.type === "function_call_output",
    );

    const user = body.input.find((item) => "role" in item && item.role === "user");

    const challenge =
      user && "content" in user ? (user.content.match(/challenge ([a-f0-9]+)/)?.[1] ?? "") : "";

    const proof = result
      ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ token: Schema.String })))(
          result.output,
        ).token
      : "";

    const output = result
      ? [
          {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: controls.streamMode === "wrong_token" ? "incorrect" : proof,
                annotations: [],
              },
            ],
          },
        ]
      : [
          {
            type: "reasoning",
            id: "reason-1",
            summary: [],
            encrypted_content: "test-reasoning-state",
          },
          {
            type: "function_call",
            id: "call-1",
            call_id: "call-1",
            name: "get_verification_token",
            namespace:
              controls.streamMode === "wrong_tool" ? "other_namespace" : "poppet_verification",
            arguments: JSON.stringify({ challenge }),
            status: "completed",
          },
        ];

    const event = Match.value(controls.streamMode).pipe(
      Match.when("failed", () => ({
        type: "response.failed",
        response: {
          id: "response-1",
          status: "failed",
          output: [],
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      })),
      Match.when("incomplete", () => ({
        type: "response.incomplete",
        response: { id: "response-1", status: "incomplete", output: [], error: null },
      })),
      Match.orElse(() => ({
        type: "response.completed",
        response: {
          id: "response-1",
          status: "completed",
          output: controls.streamMode === "empty_terminal" ? [] : output,
          error: null,
        },
      })),
    );

    const itemEvents = ["empty_terminal", "truncated", "failed", "incomplete"].includes(
      controls.streamMode,
    )
      ? output.map((item, output_index) => ({
          type: "response.output_item.done",
          output_index,
          item,
        }))
      : [];

    const events = [
      ...itemEvents.toReversed(),
      ...(controls.streamMode === "truncated" ? [] : [event]),
    ];

    const stream = `${events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;

    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };

  return { handle, requests, bearerHeaders };
};
