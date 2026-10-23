import type { Database } from "bun:sqlite";

import { BoundedText } from "@poppet/agent";
import { ToolCall } from "@poppet/store";
import { Option, Schema } from "effect";

import { TaskError, type Task } from "#src/task-schema";

export const Observation = Schema.Struct({
  value: BoundedText(1024),
  summary: BoundedText(2048),
  sourceCallIds: Schema.Array(BoundedText(128)).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});

const sourceText = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0));

const PageEvidence = Schema.Struct({
  text: sourceText,
  url: sourceText,
  truncated: Schema.Literal(false),
});

const MCPEvidence = Schema.Struct({
  content: Schema.Array(Schema.String),
  structuredContent: Schema.NullOr(Schema.Json),
  omittedContent: Schema.Literal(0),
  omittedStructuredContent: Schema.Literal(false),
  truncated: Schema.Literal(false),
  redacted: Schema.Literal(false),
});

const Sources = Schema.Array(
  Schema.Struct({ callId: BoundedText(128), source: BoundedText(2048) }),
);

const MonitorResult = Schema.Struct({
  occurrenceId: Schema.String,
  value: Observation.fields.value,
  summary: Observation.fields.summary,
  sources: Schema.fromJsonString(Sources),
  observedAt: Schema.Natural,
  previousValue: Schema.NullOr(Observation.fields.value),
  decision: Schema.Literals(["baseline", "unchanged", "changed"]),
  notificationText: Schema.NullOr(Schema.String),
});

const resultSql = `SELECT occurrence_id AS occurrenceId, value, summary, sources,
  observed_at AS observedAt, previous_value AS previousValue, decision,
  notification_text AS notificationText FROM job_monitor_results`;

const invalid = () => new TaskError({ message: "monitor:invalid-observation" });

/** Monitoring decisions are projections of completed journal entries, never model-written state. */
export const monitoringRecords = (database: Database) => {
  const active = (run: { readonly sessionId: string; readonly runId: string }) =>
    database
      .query(`SELECT o.id FROM job_occurrences o JOIN jobs j ON j.id = o.job_id
      JOIN runs r ON r.id = o.run_id AND r.session_id = o.session_id
      WHERE o.status = 'running' AND json_extract(o.definition, '$.monitor') = 1 AND r.status = 'running'
        AND o.session_id = ? AND o.run_id = ?`)
      .get(run.sessionId, run.runId) !== null;

  const calls = (runId: string) =>
    Schema.decodeUnknownSync(Schema.Array(ToolCall))(
      database
        .query(`SELECT run_id AS runId, call_id AS callId, position, name, namespace,
        arguments, server_id AS serverId, tool_name AS toolName, status,
        created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
        output, failure_reason AS failureReason FROM tool_calls WHERE run_id = ? ORDER BY position`)
        .all(runId),
    );

  const validate = (runId: string, observation: typeof Observation.Type, before = Infinity) => {
    if (new Set(observation.sourceCallIds).size !== observation.sourceCallIds.length)
      throw invalid();

    const journal = calls(runId);

    const sources = observation.sourceCallIds.map((id) => {
      const call = journal.find((entry) => entry.callId === id);

      if (
        call === undefined ||
        call.status !== "completed" ||
        call.position >= before ||
        call.output === null
      )
        throw invalid();

      let locator: string;

      if (call.namespace === "poppet_web" && call.name === "fetch_page") {
        const data = Option.getOrNull(
          Schema.decodeUnknownOption(Schema.fromJsonString(PageEvidence))(call.output),
        );

        if (data === null) throw invalid();
        locator = data.url;
      } else if (
        call.namespace === "poppet_mcp" &&
        call.serverId !== null &&
        call.toolName !== null
      ) {
        const data = Option.getOrNull(
          Schema.decodeUnknownOption(Schema.fromJsonString(MCPEvidence))(call.output),
        );

        if (
          data === null ||
          (!data.content.some((part) => part.trim()) &&
            (data.structuredContent === null ||
              ["{}", "[]", '""'].includes(JSON.stringify(data.structuredContent))))
        )
          throw invalid();
        locator = `${call.serverId}.${call.toolName}`;
      } else throw invalid();

      const source = `${locator} [${call.namespace}.${call.name}, call ${id}]`;

      if (Buffer.byteLength(source) > 2048) throw invalid();

      return { callId: id, source };
    });

    return { ...observation, sources };
  };

  const result = (occurrenceId: string) =>
    Schema.decodeUnknownSync(Schema.NullOr(MonitorResult))(
      database.query(`${resultSql} WHERE occurrence_id = ?`).get(occurrenceId),
    );

  const latest = (jobId: string, after = 0) =>
    Schema.decodeUnknownSync(Schema.NullOr(MonitorResult))(
      database
        .query(`${resultSql} WHERE job_id = ? AND id > ? ORDER BY id DESC LIMIT 1`)
        .get(jobId, after),
    );

  // The caller commits this projection and occurrence completion in the same transaction.
  const finish = (id: string, job: Task) => {
    if (result(id) !== null) return;

    const linked = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.Struct({ runId: Schema.String }))(
        database
          .query(`SELECT o.run_id AS runId FROM job_occurrences o JOIN runs r ON r.id = o.run_id
        AND r.session_id = o.session_id WHERE o.id = ? AND o.job_id = ? AND o.status = 'running' AND r.status = 'completed'`)
          .get(id, job.id),
      ),
    );

    if (linked === null) throw invalid();

    const candidates = calls(linked.runId).filter(
      (call) => call.namespace === "poppet_monitor" && call.name === "report_observation",
    );

    const candidate = candidates[0];

    if (
      candidates.length !== 1 ||
      candidate?.status !== "completed" ||
      candidate.finishedAt === null ||
      candidate.serverId !== "monitor" ||
      candidate.toolName !== "report_observation"
    )
      throw invalid();

    const input = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.fromJsonString(Observation), {
        onExcessProperty: "error",
      })(candidate.arguments),
    );

    if (input === null) throw invalid();

    const observedAt = candidate.finishedAt;
    const observation = validate(linked.runId, input, candidate.position);
    const previous = latest(job.id, job.monitorBaselineAfter);

    const decision =
      previous === null
        ? "baseline"
        : previous.value === observation.value
          ? "unchanged"
          : "changed";

    const notification =
      decision === "changed"
        ? `${job.name} changed\nPrevious: ${previous!.value}\nCurrent: ${observation.value}\nObserved: ${new Date(observedAt).toISOString()}\n${observation.summary}\nSources:\n${observation.sources.map((source) => source.source).join("\n")}`
        : null;

    database
      .query(`INSERT INTO job_monitor_results
      (occurrence_id, job_id, value, summary, sources, observed_at, previous_value, decision, notification_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        job.id,
        observation.value,
        observation.summary,
        JSON.stringify(observation.sources),
        observedAt,
        previous?.value ?? null,
        decision,
        notification,
      );
  };

  return { active, validate, result, latest, finish };
};
