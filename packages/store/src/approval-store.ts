import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { AppConfig } from "@poppet/config";
import { Context, Effect, Layer, Schema } from "effect";

import { Approval, ApprovalState, ActionProposal } from "#src/approval-schema";
import { CommandArguments } from "#src/command-schema";
import { StoreDatabase } from "#src/database";
import { StoreError, storageFailure } from "#src/errors";

const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");

const select = `SELECT id, owner, payload, digest, source_session_id AS sessionId,
  source_run_id AS runId, source_call_id AS callId, job_id AS jobId, revision,
  occurrence_id AS occurrenceId, destination, created_at AS createdAt,
  expires_at AS expiresAt, state, receipt FROM action_proposals`;

export const makeApprovalStore = (
  database: StoreDatabase["Service"]["database"],
  owner: string,
) => {
  const decode = (input: typeof Approval.Encoded) => {
    const value = Schema.decodeUnknownSync(Approval)(input);

    if (value.owner !== owner || value.digest !== digest(input.payload))
      throw new StoreError({
        reason: "corrupt",
        message: "Proposal ownership or payload integrity does not match.",
      });

    return value;
  };

  const get = (id: string) => {
    const raw = database
      .query<typeof Approval.Encoded, [string, string]>(`${select} WHERE id = ? AND owner = ?`)
      .get(id, owner);

    if (raw === null)
      throw new StoreError({
        reason: "not-found",
        message: "The proposal does not exist for this owner.",
      });

    return decode(raw);
  };

  const finish = (
    id: string,
    state: ApprovalState,
    at: number,
    reason: string | null,
    details: Schema.JsonObject = {},
  ) => {
    const value = get(id);

    const receipt = {
      ...details,
      id,
      digest: value.digest,
      state,
      at,
      type: value.payload.type,
      ...(value.payload.type === "create_note"
        ? { path: value.payload.path }
        : { command: value.payload.request }),
      reason,
    };

    database
      .query("UPDATE action_proposals SET state = ?, receipt = ? WHERE id = ? AND owner = ?")
      .run(state, JSON.stringify(receipt), id, owner);

    return get(id);
  };

  const refresh = (at: number) => {
    database
      .query(`UPDATE action_proposals SET state = 'cancelled',
      receipt = json_object('id', id, 'digest', digest, 'state', 'cancelled', 'at', ?, 'reason', 'The source task definition or permission changed.')
      WHERE owner = ? AND state = 'pending' AND job_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jobs WHERE jobs.id = action_proposals.job_id AND jobs.revision = action_proposals.revision
          AND jobs.monitor = 0 AND (
            (json_extract(action_proposals.payload, '$.type') = 'create_note' AND jobs.proposal_note = json_extract(action_proposals.payload, '$.path'))
            OR (json_extract(action_proposals.payload, '$.type') = 'execute_command' AND jobs.proposal_command = action_proposals.payload)))`)
      .run(at, owner);
    database
      .query(`UPDATE action_proposals SET state = 'expired',
      receipt = json_object('id', id, 'digest', digest, 'state', 'expired', 'at', ?, 'reason', 'The proposal expired.')
      WHERE owner = ? AND state = 'pending' AND expires_at <= ?`)
      .run(at, owner, at);
  };

  return {
    advice: (id: string, advice: Schema.JsonObject | null) => {
      if (advice !== null)
        database
          .query(
            "UPDATE action_proposals SET receipt = ? WHERE id = ? AND owner = ? AND state = 'pending' AND receipt IS NULL",
          )
          .run(JSON.stringify({ advisoryReview: advice }), id, owner);
    },
    recover: () =>
      database
        .query(`UPDATE action_proposals SET state = 'uncertain',
      receipt = json_patch(COALESCE(receipt, '{}'), json_object('id', id, 'digest', digest, 'state', 'uncertain', 'reason', 'Execution ended without a durable outcome. Inspect the target before preparing another proposal.'))
      WHERE owner = ? AND state = 'executing'`)
        .run(owner),
    show: (id: string, at: number) => {
      refresh(at);

      return get(id);
    },
    list: (at: number) => {
      refresh(at);

      return database
        .query<typeof Approval.Encoded, [string]>(
          `${select} WHERE owner = ? ORDER BY created_at DESC, id LIMIT 50`,
        )
        .all(owner)
        .map(decode);
    },
    create: (payload: ActionProposal, runId: string, callId: string, at: number) => {
      const previous = database
        .query(
          "SELECT id FROM action_proposals WHERE source_run_id = ? AND source_call_id = ? AND owner = ?",
        )
        .get(runId, callId, owner);

      if (previous !== null)
        return get(Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(previous).id);

      const note = payload.type === "create_note";

      const source = Schema.decodeUnknownSync(
        Schema.NullOr(Schema.Struct({ sessionId: Schema.String, arguments: Schema.String })),
      )(
        database
          .query(`SELECT r.session_id AS sessionId, c.arguments FROM runs r JOIN tool_calls c ON c.run_id = r.id
            WHERE r.id = ? AND r.status = 'running' AND c.call_id = ? AND c.status = 'running'
              AND c.namespace = ? AND c.name = ?`)
          .get(
            runId,
            callId,
            note ? "poppet_approvals" : "poppet_commands",
            note ? "propose_note" : "request_command",
          ),
      );

      if (source === null)
        throw new StoreError({
          reason: "invalid-request",
          message: "The proposal payload must match its active recorded tool call.",
        });

      const argumentsMatch = note
        ? isDeepStrictEqual(JSON.parse(source.arguments), {
            path: payload.path,
            content: payload.content,
          })
        : isDeepStrictEqual(
            Schema.decodeUnknownSync(Schema.fromJsonString(CommandArguments), {
              onExcessProperty: "error",
            })(source.arguments),
            payload.request,
          );

      if (!argumentsMatch)
        throw new StoreError({
          reason: "invalid-request",
          message: "The proposal does not match its source call.",
        });

      const scheduled = Schema.decodeUnknownSync(
        Schema.NullOr(
          Schema.Struct({
            jobId: Schema.String,
            revision: Schema.Natural,
            occurrenceId: Schema.String,
            definition: Schema.String,
            destination: Schema.NullOr(Schema.String),
          }),
        ),
      )(
        database
          .query(`SELECT job_id AS jobId, revision, id AS occurrenceId, definition, destination
        FROM job_occurrences WHERE run_id = ? AND status = 'running'`)
          .get(runId),
      );

      if (scheduled !== null) {
        const definition = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              monitor: Schema.Boolean,
              proposalNote: Schema.NullOr(Schema.String),
              proposalCommand: Schema.optionalKey(Schema.Unknown),
            }),
          ),
        )(scheduled.definition);

        if (
          definition.monitor ||
          (note
            ? definition.proposalNote !== payload.path
            : !isDeepStrictEqual(definition.proposalCommand, payload))
        )
          throw new StoreError({
            reason: "invalid-request",
            message: "This occurrence cannot propose this destination.",
          });

        if (
          database
            .query("SELECT id FROM action_proposals WHERE occurrence_id = ?")
            .get(scheduled.occurrenceId) !== null
        )
          throw new StoreError({
            reason: "conflict",
            message: "This occurrence already prepared its permitted proposal.",
          });
      }

      if (!note && scheduled === null) {
        const grant = database
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM command_run_grants WHERE run_id = ?",
          )
          .get(runId);

        if (grant === null || !isDeepStrictEqual(JSON.parse(grant.payload), payload.grant))
          throw new StoreError({
            reason: "invalid-request",
            message: "This run has no matching command grant.",
          });
      }

      const encoded = Schema.encodeSync(Schema.fromJsonString(ActionProposal))(payload);
      const id = randomUUID();
      database
        .query(`INSERT INTO action_proposals
        (id, owner, payload, digest, source_session_id, source_run_id, source_call_id,
        job_id, revision, occurrence_id, destination, created_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(
          id,
          owner,
          encoded,
          digest(encoded),
          source.sessionId,
          runId,
          callId,
          scheduled?.jobId ?? null,
          scheduled?.revision ?? null,
          scheduled?.occurrenceId ?? null,
          scheduled?.destination ?? null,
          at,
          at + 86400000,
        );

      return get(id);
    },
    claim: (id: string, at: number, authority?: Schema.JsonObject) =>
      database
        .transaction(() => {
          refresh(at);
          const value = get(id);

          if (value.state !== "pending") return { value, claimed: false };
          database
            .query(
              "UPDATE action_proposals SET state = 'executing', receipt = ? WHERE id = ? AND owner = ? AND state = 'pending'",
            )
            .run(authority === undefined ? null : JSON.stringify({ ...authority, at }), id, owner);

          return { value: get(id), claimed: true };
        })
        .immediate(),
    cancel: (id: string, at: number) =>
      database
        .transaction(() => {
          refresh(at);
          const value = get(id);

          return value.state === "pending"
            ? finish(id, "cancelled", at, "Cancelled by the owner.")
            : value;
        })
        .immediate(),
    failPending: (id: string, at: number, reason: string) => {
      refresh(at);

      return get(id).state === "pending" ? finish(id, "failed", at, reason) : get(id);
    },
    settle: (
      id: string,
      state: "completed" | "failed" | "uncertain",
      at: number,
      reason: string | null,
      details: Schema.JsonObject = {},
    ) =>
      get(id).state === "executing"
        ? finish(id, state, at, reason, { ...get(id).receipt, ...details })
        : get(id),
  };
};

export class ApprovalRepository extends Context.Service<
  ApprovalRepository,
  ReturnType<typeof makeApprovalStore>
>()("poppet/ApprovalRepository") {}

export const ApprovalRepositoryLive = Layer.effect(
  ApprovalRepository,
  Effect.gen(function* () {
    const { database } = yield* StoreDatabase;
    const config = yield* AppConfig;

    const directory = yield* Effect.tryPromise({
      try: () => realpath(config.dataDirectory),
      catch: storageFailure,
    });

    const repository = makeApprovalStore(database, `${process.getuid?.() ?? "local"}:${directory}`);
    yield* Effect.try({ try: repository.recover, catch: storageFailure });

    return repository;
  }),
);
