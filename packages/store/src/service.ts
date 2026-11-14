import { Completion, ProviderId, type Message as ModelMessage } from "@poppet/provider";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { StoreDatabase, StoreDatabaseLive } from "#src/database";
import { StoreError, reportAs, storeFailure } from "#src/errors";
import { storeSchema } from "#src/migrations";
import { readSession } from "#src/recall";
import { storeRecords } from "#src/records";
import { runOperations } from "#src/runs";
import {
  type NewAttachment,
  Run,
  RunOutcome,
  type SavedAttachment,
  Session,
  SkillSnapshot,
  type SessionSearchResult,
  type SessionReadQuery,
  type SessionReadResult,
  StoredMessage,
  ToolCall,
  ToolOutcome,
  type StoreStatus,
} from "#src/schema";
import { searchSessions } from "#src/search";
import { sessionOperations } from "#src/sessions";
import { decodeRow } from "#src/sql";
import { toolCallOperations } from "#src/tool-calls";

export interface StoreOperations {
  readonly status: Effect.Effect<StoreStatus, StoreError>;
  readonly createSession: (
    provider: ProviderId,
    model: string,
    options?: {
      readonly id?: string;
      readonly taskTitle?: string;
      readonly skill?: SkillSnapshot | null;
    },
  ) => Effect.Effect<Session, StoreError>;
  readonly renameSession: (id: string, title: string) => Effect.Effect<Session, StoreError>;
  readonly claimTitle: (id: string) => Effect.Effect<Session | null, StoreError>;
  readonly finishTitle: (
    id: string,
    title: string | null,
    usage: Completion["usage"],
  ) => Effect.Effect<void, StoreError>;
  readonly session: (id: string) => Effect.Effect<Session | null, StoreError>;
  readonly sessions: Effect.Effect<ReadonlyArray<Session>, StoreError>;
  readonly searchSessions: (
    query: string,
    maxBytes: number,
  ) => Effect.Effect<SessionSearchResult, StoreError>;
  readonly readSession: (
    query: SessionReadQuery,
    maxBytes: number,
  ) => Effect.Effect<SessionReadResult, StoreError>;
  readonly messages: (sessionId: string) => Effect.Effect<ReadonlyArray<StoredMessage>, StoreError>;
  readonly queueRun: (
    sessionId: string,
    input: ReadonlyArray<ModelMessage>,
    id?: string,
    fallbackTitle?: string,
    attachments?: ReadonlyArray<NewAttachment>,
  ) => Effect.Effect<Run, StoreError>;
  readonly attachments: (
    sessionId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<SavedAttachment>, StoreError>;
  readonly startRun: (id: string) => Effect.Effect<Run, StoreError>;
  readonly finishRun: (id: string, outcome: RunOutcome) => Effect.Effect<Run, StoreError>;
  readonly run: (id: string) => Effect.Effect<Run | null, StoreError>;
  readonly runs: (sessionId: string) => Effect.Effect<ReadonlyArray<Run>, StoreError>;
  readonly recordToolCalls: (
    runId: string,
    response: Completion,
    identities?: ReadonlyArray<{
      readonly callId: string;
      readonly serverId: string;
      readonly toolName: string;
    }>,
  ) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  readonly toolCalls: (runId: string) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  readonly startToolCall: (runId: string, callId: string) => Effect.Effect<void, StoreError>;
  readonly finishToolCall: (
    runId: string,
    callId: string,
    outcome: ToolOutcome,
  ) => Effect.Effect<void, StoreError>;
  readonly commitToolCall: <E, R>(
    runId: string,
    callId: string,
    operation: Effect.Effect<string, E, R>,
  ) => Effect.Effect<string, StoreError | E, R>;
}

export class Store extends Context.Service<Store, StoreOperations>()("poppet/Store") {}

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { path } = yield* StoreDatabase;
    const records = storeRecords(sql);
    const { transaction } = records;

    yield* transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        yield* sql`UPDATE tool_calls
          SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE 'interrupted' END,
            finished_at = MAX(created_at, COALESCE(started_at, 0), ${at}),
            failure_reason = 'process-exit'
          WHERE status IN ('pending', 'running')`;

        yield* sql`UPDATE runs SET status = 'interrupted',
            finished_at = MAX(created_at, COALESCE(started_at, 0), ${at}),
            failure_reason = 'process-exit'
          WHERE status IN ('pending', 'running')`;
      }),
    );

    return {
      ...sessionOperations(sql, records),
      ...runOperations(sql, records),
      ...toolCallOperations(sql, records),
      searchSessions: (query, maxBytes) =>
        searchSessions(sql, query, maxBytes).pipe(reportAs(storeFailure)),
      readSession: (query, maxBytes) =>
        readSession(sql, query, maxBytes).pipe(reportAs(storeFailure)),
      status: sql`SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
          (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM runs) AS runs`.pipe(
        decodeRow(
          Schema.Struct({
            sessions: Schema.Natural,
            messages: Schema.Natural,
            runs: Schema.Natural,
          }),
        ),
        Effect.map((counts) => ({
          path,
          schemaVersion: storeSchema.version,
          sessions: counts?.sessions ?? 0,
          messages: counts?.messages ?? 0,
          runs: counts?.runs ?? 0,
        })),
        reportAs(storeFailure),
      ),
    } satisfies StoreOperations;
  }),
).pipe(Layer.provideMerge(StoreDatabaseLive));
