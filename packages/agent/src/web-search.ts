import { toolParameters } from "@poppet/provider";
import type { Tool } from "@poppet/provider";
import { WebSearch } from "@poppet/web-search";
import { Effect, Schema } from "effect";

import { contextTool } from "#src/agent-tool";
import type { ToolCall } from "#src/agent-tool";
import { AgentError } from "#src/errors";
import { BoundedText, toolArguments } from "#src/tool-schema";

export { WebSearch } from "@poppet/web-search";

const SearchArguments = Schema.Struct({
  query: BoundedText(512).annotate({
    description: "Nonempty, trimmed search query (max 512 UTF-8 bytes).",
  }),
});

export const webSearchDefinition: Tool = {
  name: "search_web",
  namespace: "poppet_web",
  description: [
    "Search the web for current information.",
    "Only the query is sent to the configured search provider, so omit unrelated private context.",
    "Returns up to 5 titles, URLs, and snippets (which may include extracted page passages).",
    "Answer from snippets when sufficient, or use fetch_page for more detail;",
    "distinguish excerpts from directly fetched pages and cite source URLs.",
  ].join(" "),
  parameters: toolParameters(SearchArguments),
};

export const decodeWebSearchCall = (call: ToolCall) =>
  toolArguments(
    webSearchDefinition,
    SearchArguments,
  )(call.arguments).pipe(Effect.map(({ query }) => query));

export const webSearchTool = Effect.gen(function* () {
  const { search } = yield* WebSearch;

  if (search === null) {
    return null;
  }

  return contextTool({
    definition: webSearchDefinition,
    prepare: (call) =>
      decodeWebSearchCall(call).pipe(
        Effect.map((query) => {
          let urls: ReadonlyArray<string> = [];

          return {
            execute: search(query).pipe(
              Effect.mapError(
                (error) => new AgentError({ reason: error.reason, message: error.message }),
              ),
              Effect.map((value) => {
                urls = value.results.map((item) => item.url);

                return JSON.stringify(value);
              }),
            ),
            grantedURLs: () => urls,
          };
        }),
      ),
    untrustedResult: true,
  });
});
