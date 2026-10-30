import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { DoctorSnapshot } from "#src/doctor-report";

export const gatewayObservation = (status: Schema.JsonObject) => {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      channels: Schema.Array(
        Schema.Struct({
          enabled: Schema.Boolean,
          connected: Schema.optionalKey(Schema.Boolean),
          error: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ).check(Schema.isMaxLength(128)),
    }),
  )(status);

  if (Option.isNone(decoded))
    return { enabled: 0, disconnected: 0, unknown: 1, configurationErrors: 0 };
  const channels = decoded.value.channels;

  return {
    enabled: channels.filter((channel) => channel.enabled).length,
    disconnected: channels.filter((channel) => channel.enabled && channel.connected === false)
      .length,
    unknown: channels.filter((channel) => channel.enabled && channel.connected === undefined)
      .length,
    configurationErrors: channels.filter((channel) => !channel.enabled && channel.error != null)
      .length,
  };
};

/** Queries the worker's existing connection. No runtime construction, auth calls or recovery. */
export const doctorSnapshot = (identity: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const observedAt = Date.now();

    const counts = yield* sql`SELECT
    (SELECT COUNT(*) FROM job_occurrences WHERE status = 'failed' AND finished_at >= ${observedAt - 86400000}) AS failed,
    (SELECT COUNT(*) FROM job_occurrences WHERE status = 'interrupted' AND finished_at >= ${observedAt - 86400000}) AS interrupted,
    (SELECT COUNT(*) FROM job_occurrences WHERE status = 'running') AS running,
    (SELECT MIN(at) FROM (
      SELECT available_at AS at FROM job_occurrences WHERE status = 'pending'
      UNION ALL SELECT next_at AS at FROM jobs WHERE paused = 0 AND NOT EXISTS
        (SELECT 1 FROM job_occurrences WHERE job_id = jobs.id AND status IN ('pending', 'running'))
    )) AS next_at`;

    const recent = yield* sql`SELECT id, job_id, status FROM job_occurrences
      WHERE status IN ('failed', 'interrupted') AND finished_at >= ${observedAt - 86400000}
      ORDER BY finished_at DESC, id DESC LIMIT 5`;

    const holds = yield* sql`SELECT provider, CASE WHEN reason = 'quota' THEN 'quota'
    WHEN reason = 'temporary' THEN 'temporary' WHEN reason = 'rate-limit' THEN 'rate-limit' ELSE 'other' END AS reason, resume_at
    FROM job_provider_pauses ORDER BY provider LIMIT 20`;

    const totals = yield* sql`SELECT COUNT(*) AS count FROM job_provider_pauses`;

    const delivery = yield* sql`SELECT
    (SELECT COUNT(*) FROM gateway_deliveries WHERE state IN ('pending', 'sending')) AS pending,
    (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'failed') AS failed,
    (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'uncertain') AS uncertain`;

    return yield* Schema.decodeUnknownEffect(DoctorSnapshot)({
      version: 1,
      identity,
      observedAt,
      tasks: counts[0],
      recent,
      holds,
      holdsOmitted: Math.max(0, Number(totals[0]?.count ?? 0) - holds.length),
      delivery: delivery[0],
    });
  });
