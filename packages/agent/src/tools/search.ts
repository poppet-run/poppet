import { toolParameters } from "@poppet/provider";
import type { Tool } from "@poppet/provider";
import { SessionReadQuery, SessionSearchQuery, Store } from "@poppet/store";
import type { StoreError } from "@poppet/store";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";
import { ChatSettings } from "#src/settings";
import { contextTool } from "#src/tools/agent-tool";
import type { ToolCall } from "#src/tools/agent-tool";
import { toolArguments } from "#src/tools/tool-schema";

const SearchArguments = Schema.Struct({
  query: SessionSearchQuery.annotate({ description: "Plain-text search query." }),
});

const ReadArguments = Schema.Struct({
  session_id: SessionReadQuery.fields.sessionId.annotate({ description: "Completed session ID." }),
  around_message_id: SessionReadQuery.fields.aroundMessageId.annotate({
    description: "Message ID from search_sessions to read around, or null.",
  }),
  after_message_id: SessionReadQuery.fields.afterMessageId.annotate({
    description: "nextAfterMessageId cursor to page forward, or null.",
  }),
});

export const sessionReadDefinition: Tool = {
  name: "read_session",
  namespace: "poppet_history",
  description: [
    "Read saved user and final assistant messages from a completed conversation.",
    "Supply session_id and null for unused anchors;",
    "use around_message_id or after_message_id, never both.",
    "Returns up to 10 messages, marking shortened messages or omitted context as truncated.",
    "Cite recalled statements by session and message IDs and distinguish them from current facts.",
  ].join(" "),
  parameters: toolParameters(ReadArguments),
};

export const decodeSessionReadCall = (
  call: ToolCall,
): Effect.Effect<SessionReadQuery, AgentError> =>
  toolArguments(
    sessionReadDefinition,
    ReadArguments,
  )(call.arguments).pipe(
    Effect.flatMap((args) =>
      Schema.decodeUnknownEffect(SessionReadQuery)({
        sessionId: args.session_id,
        aroundMessageId: args.around_message_id,
        afterMessageId: args.after_message_id,
      }).pipe(
        Effect.mapError(
          () =>
            new AgentError({
              reason: "tool-arguments",
              message: "Invalid arguments for poppet_history.read_session.",
            }),
        ),
      ),
    ),
  );

export const sessionSearchDefinition: Tool = {
  name: "search_sessions",
  namespace: "poppet_history",
  description: [
    "Search the owner's completed conversations with plain text.",
    "Use this first when you lack a session ID, then read_session around a match.",
    "Returns up to 10 excerpts with session IDs and titles.",
  ].join(" "),
  parameters: toolParameters(SearchArguments),
};

export const decodeSessionSearchCall = (call: ToolCall): Effect.Effect<string, AgentError> =>
  toolArguments(
    sessionSearchDefinition,
    SearchArguments,
  )(call.arguments).pipe(Effect.map(({ query }) => query));

const historyTool = <Q>(
  definition: Tool,
  decode: (call: ToolCall) => Effect.Effect<Q, AgentError>,
  read: (
    store: Store["Service"],
    query: Q,
    toolBytes: number,
  ) => Effect.Effect<unknown, StoreError>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const { toolBytes } = yield* ChatSettings;

    return contextTool({
      definition,
      prepare: (call) =>
        decode(call).pipe(
          Effect.map((query) => ({
            execute: read(store, query, toolBytes).pipe(
              Effect.map((value) => JSON.stringify(value)),
            ),
          })),
        ),
      untrustedResult: false,
    });
  });

export const sessionSearchTool = historyTool(
  sessionSearchDefinition,
  decodeSessionSearchCall,
  (store, query, toolBytes) => store.searchSessions(query, toolBytes),
);

export const sessionReadTool = historyTool(
  sessionReadDefinition,
  decodeSessionReadCall,
  (store, query, toolBytes) => store.readSession(query, toolBytes),
);
