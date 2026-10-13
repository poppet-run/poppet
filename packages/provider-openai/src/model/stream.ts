import { Effect } from "effect";
import type OpenAI from "openai";
import type {
  Response as ModelResponse,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";

import { ConnectionError, requestFailure } from "../connection.ts";
import { modelFailure } from "./client.ts";

export const complete = (client: OpenAI, request: ResponseCreateParamsStreaming) =>
  Effect.tryPromise({
    try: async (signal) => {
      const stream = await client.responses.create(request, { signal });
      let response: ModelResponse | null = null;
      const completedItems = new Map<number, ModelResponse["output"][number]>();

      for await (const event of stream) {
        // Completed items can carry output that the final response omits.
        // Save their indexes so we can restore the model's output order later.
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

      // Receiving output alone is not success. A truncated stream may contain
      // valid items, so require the terminal completed response as well.
      if (!response || response.status !== "completed")
        throw new ConnectionError({
          reason: "interrupted",
          message: "The stream ended without completed inference. Verification did not pass.",
        });

      // Fill gaps from the terminal snapshot, keeping streamed completed items
      // when both sources describe the same output index.
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
