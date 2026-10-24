import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { decodeRow, decodeRows, migrate, reportAs } from "@poppet/store";
import { Clock, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { memoryLimit, readContextFile } from "#src/context-file";
import { memorySchema } from "#src/migrations";
import { MemoryFact, MemoryRevision, SnapshotLimits, type MemoryOrigin } from "#src/schema";
import { Memory, MemoryError } from "#src/service";

const invalid = () =>
  new MemoryError({ reason: "invalid-request", message: "The memory request is invalid." });

/** Validates caller input before any query runs. */
const input = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));

// Caller input is validated first, so a schema failure here means a saved row is invalid.
const memoryFailure = (cause: unknown) =>
  cause instanceof MemoryError
    ? cause
    : cause instanceof Schema.SchemaError
      ? new MemoryError({
          reason: "corrupt",
          message: "The memory store contains an invalid fact.",
        })
      : new MemoryError({
          reason: "storage",
          message: "Poppet could not read or write its local memory.",
        });

const fail = (reason: MemoryError["reason"], message: string) =>
  Effect.fail(new MemoryError({ reason, message }));

// The host supplies the same SQLite connection used by conversation storage.
export const LocalMemoryLive = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* AppConfig;
    yield* migrate(memorySchema);

    const readContext = (name: string, maximum: number, setting: string) => {
      const path = join(config.dataDirectory, name);

      return Effect.tryPromise({
        try: () => readContextFile(path, maximum, setting),
        catch: (cause) =>
          cause instanceof MemoryError
            ? cause
            : new MemoryError({
                reason: "storage",
                message: `Could not read ${path}. Use a regular UTF-8 file without a symlink.`,
              }),
      });
    };

    const list = sql`SELECT * FROM memories ORDER BY key`.pipe(
      decodeRows(MemoryFact),
      reportAs(memoryFailure),
    );

    const current = (key: string) =>
      sql`SELECT * FROM memories WHERE key = ${key}`.pipe(decodeRow(MemoryFact));

    const requireSource = (sourceRunId: string | null) =>
      Effect.gen(function* () {
        if (sourceRunId === null) return;

        const source = yield* sql`SELECT id FROM runs WHERE id = ${sourceRunId}`;

        if (source.length === 0) return yield* fail("not-found", "The source run does not exist.");
      });

    const requireRoom = Effect.gen(function* () {
      const saved = yield* sql`SELECT COUNT(*) AS count FROM memories`.pipe(
        decodeRow(Schema.Struct({ count: Schema.Natural })),
      );

      if ((saved?.count ?? 0) >= 128)
        return yield* fail(
          "conflict",
          "Memory holds at most 128 facts. Forget a fact before adding another.",
        );
    });

    // Facts are their latest revision, so each change appends exactly one row.
    const commit = (
      key: string,
      action: MemoryRevision["action"],
      value: string | null,
      sourceRunId: string | null,
      origin: MemoryOrigin,
      at: number,
    ) =>
      Effect.gen(function* () {
        const existing = yield* current(key);
        // Keep update times moving forward even if the clock steps back.
        const updatedAt = Math.max(at, existing?.updatedAt ?? 0);

        yield* sql`INSERT INTO memory_revisions (key, revision, action, value, origin, source_run_id, created_at)
          SELECT ${key}, COALESCE(MAX(revision), 0) + 1, ${action}, ${value}, ${origin},
            ${sourceRunId}, ${updatedAt}
          FROM memory_revisions WHERE key = ${key}`;

        return value === null
          ? null
          : ({ key, value, origin, sourceRunId, updatedAt } satisfies MemoryFact);
      });

    const transaction = <A, E, R>(change: (at: number) => Effect.Effect<A, E, R>) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) => sql.withTransaction(change(at))),
        reportAs(memoryFailure),
      );

    const saveMemory = (
      key: string,
      value: string,
      sourceRunId: string | null,
      mode: "remember" | "replace",
    ) =>
      transaction((at) =>
        Effect.gen(function* () {
          yield* input(MemoryFact.fields.key, key);
          yield* input(MemoryFact.fields.value, value);
          yield* requireSource(sourceRunId);
          const existing = yield* current(key);

          if (mode === "replace" && existing === null)
            return yield* fail(
              "not-found",
              "The fact does not exist. Use memory remember to create it.",
            );

          if (mode === "remember" && existing !== null)
            return yield* fail(
              "conflict",
              "The fact already exists. Use memory replace to change it.",
            );

          if (mode === "remember") yield* requireRoom;

          return (yield* commit(
            key,
            mode,
            value,
            sourceRunId,
            sourceRunId === null ? "cli" : "turn",
            at,
          ))!;
        }),
      );

    return {
      list,
      remember: (key, value, sourceRunId = null) => saveMemory(key, value, sourceRunId, "remember"),
      replace: (key, value, sourceRunId = null) => saveMemory(key, value, sourceRunId, "replace"),
      forget: (key, sourceRunId = null) =>
        transaction((at) =>
          Effect.gen(function* () {
            yield* input(MemoryFact.fields.key, key);
            yield* requireSource(sourceRunId);

            if ((yield* current(key)) === null)
              return yield* fail("not-found", "The fact does not exist.");

            yield* commit(
              key,
              "forget",
              null,
              sourceRunId,
              sourceRunId === null ? "cli" : "turn",
              at,
            );
          }),
        ),
      history: (key) =>
        input(MemoryFact.fields.key, key).pipe(
          Effect.andThen(
            sql`SELECT * FROM memory_revisions WHERE key = ${key} ORDER BY revision`.pipe(
              decodeRows(MemoryRevision),
            ),
          ),
          reportAs(memoryFailure),
        ),
      revert: (key, revision) =>
        transaction((at) =>
          Effect.gen(function* () {
            yield* input(MemoryFact.fields.key, key);

            const target = yield* sql`SELECT * FROM memory_revisions
              WHERE key = ${key} AND revision = ${revision}`.pipe(decodeRow(MemoryRevision));

            if (target === null)
              return yield* fail("not-found", "The fact revision does not exist.");

            const existing = yield* current(key);

            if (target.value === null) {
              if (existing === null)
                return yield* fail("conflict", "The fact is already forgotten.");

              return yield* commit(key, "forget", null, null, "cli", at);
            }

            if (existing?.value === target.value)
              return yield* fail("conflict", "The fact already has this value.");

            if (existing === null) yield* requireRoom;

            return yield* commit(key, "revert", target.value, null, "cli", at);
          }),
        ),
      snapshot: (limits) =>
        Effect.gen(function* () {
          const budget = yield* Schema.decodeUnknownEffect(SnapshotLimits, {
            onExcessProperty: "error",
          })(limits).pipe(Effect.mapError(invalid));

          const soul = yield* readContext("soul.md", budget.soulBytes, "POPPET_SOUL_BYTES");

          const profile = yield* readContext(
            "profile.md",
            budget.profileBytes,
            "POPPET_PROFILE_BYTES",
          );

          const facts = (yield* list).map(({ key, value }) => ({ key, value }));

          if (
            facts.length > 0 &&
            Buffer.byteLength(JSON.stringify(facts), "utf8") > budget.factsBytes
          )
            return yield* Effect.fail(memoryLimit("saved facts", "POPPET_FACTS_BYTES"));

          return { soul, profile, facts };
        }),
    } satisfies Memory["Service"];
  }),
);
