import { expect, test } from "bun:test";

import type { ModelDescription } from "@poppet/provider";
import { chatCompletionsModel, responsesModel } from "@poppet/provider-protocol";
import { Effect, Schema, Stream } from "effect";
import OpenAI from "openai";

import { definition } from "#src/catalog";

const description: ModelDescription = {
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  capabilities: { tools: true, generationSettings: [], contextWindow: null, maxOutputTokens: null },
};

test.each(["responses", "chat-completions"] as const)(
  "encodes optional MCP arguments for %s tool calls",
  async (protocol) => {
    const tool = definition("server", "a-long.tool/name", "Fixture", {
      type: "object",
      properties: { optional: { type: "string" } },
    });

    let requested = false;

    const client = new OpenAI({
      apiKey: "fixture",
      baseURL: "https://fixture.invalid/v1",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

        const body = Schema.decodeUnknownSync(Schema.JsonObject)(await request.json());
        requested = true;

        const parameters = {
          type: "object",
          properties: { input: { type: "string", description: "JSON-encoded tool arguments." } },
          required: ["input"],
          additionalProperties: false,
        };

        if (protocol === "responses") {
          expect(body.tools).toEqual([
            {
              type: "namespace",
              name: "poppet_mcp",
              description: "Poppet local tools.",
              tools: [
                {
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters,
                  strict: true,
                },
              ],
            },
          ]);

          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", id: "answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] }] } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }

        const name = `${tool.namespace}__${tool.name}`;
        expect(name.length).toBeLessThanOrEqual(64);
        expect(body.tools).toEqual([
          { type: "function", function: { name, description: tool.description, parameters } },
        ]);

        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const model =
      protocol === "responses"
        ? responsesModel(description, Effect.succeed(client))
        : chatCompletionsModel(description, Effect.succeed(client));

    const events = await Effect.runPromise(
      model
        .stream({
          sessionId: "fixture",
          workload: "assistant",
          instructions: "Fixture",
          messages: [{ role: "user", text: "Use MCP" }],
          tools: [tool],
          settings: {},
        })
        .pipe(Stream.runCollect),
    );

    expect(requested).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      response: { output: [{ type: "text", text: "Done" }] },
    });
  },
);
