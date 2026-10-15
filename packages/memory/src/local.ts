import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { StoreDatabase } from "@poppet/store";
import { DateTime, Effect, Layer, Schema } from "effect";

import { memoryLimit, readContextFile } from "#src/context-file";
import { MemoryFact, SnapshotLimits } from "#src/schema";
import { Memory, MemoryError } from "#src/service";

const memorySql = `SELECT key, value, source_run_id AS sourceRunId, updated_at AS updatedAt FROM memories`;

const readRecord = <A>(read: () => A): A => {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof Schema.SchemaError)
      throw new MemoryError({
        reason: "corrupt",
        message: "The memory store contains an invalid fact.",
      });
    throw cause;
  }
};

const requestFailure = (cause: unknown) => {
  if (cause instanceof MemoryError) return cause;

  return new MemoryError({
    reason: cause instanceof Schema.SchemaError ? "invalid-request" : "storage",
    message:
      cause instanceof Schema.SchemaError
        ? "The memory request is invalid."
        : "Poppet could not read or write its local memory.",
  });
};

// The host supplies the same scoped database used by conversation storage.
export const LocalMemoryLive = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const { database } = yield* StoreDatabase;
    const config = yield* AppConfig;

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

    const list = Effect.try({
      try: () =>
        readRecord(() => {
          using statement = database.prepare(`${memorySql} ORDER BY key`);

          return Schema.decodeUnknownSync(Schema.Array(MemoryFact))(statement.all());
        }),
      catch: requestFailure,
    });

    const saveMemory = (
      key: string,
      value: string,
      sourceRunId: string | null,
      mode: "remember" | "replace",
    ) =>
      Effect.gen(function* () {
        const at = (yield* DateTime.nowAsDate).getTime();

        return yield* Effect.try({
          try: () =>
            database
              .transaction(() => {
                const input = Schema.decodeUnknownSync(MemoryFact, { onExcessProperty: "error" })({
                  key,
                  value,
                  sourceRunId,
                  updatedAt: at,
                });

                if (sourceRunId !== null) {
                  using source = database.prepare("SELECT id FROM runs WHERE id = ?");

                  if (source.get(sourceRunId) === null)
                    throw new MemoryError({
                      reason: "not-found",
                      message: "The source run does not exist.",
                    });
                }

                using select = database.prepare(`${memorySql} WHERE key = ?`);

                const existing = readRecord(() =>
                  Schema.decodeUnknownSync(Schema.NullOr(MemoryFact))(select.get(key)),
                );

                if (mode === "replace" && existing === null)
                  throw new MemoryError({
                    reason: "not-found",
                    message: "The fact does not exist. Use memory remember to create it.",
                  });

                if (mode === "remember" && existing !== null)
                  throw new MemoryError({
                    reason: "conflict",
                    message: "The fact already exists. Use memory replace to change it.",
                  });

                if (mode === "remember") {
                  using count = database.prepare("SELECT COUNT(*) AS count FROM memories");

                  const total = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(
                    count.get(),
                  ).count;

                  if (total >= 128)
                    throw new MemoryError({
                      reason: "conflict",
                      message:
                        "Memory holds at most 128 facts. Forget a fact before adding another.",
                    });
                }

                const fact = { ...input, updatedAt: Math.max(at, existing?.updatedAt ?? 0) };

                using write = database.prepare(
                  mode === "replace"
                    ? "UPDATE memories SET value = ?, source_run_id = ?, updated_at = ? WHERE key = ?"
                    : "INSERT INTO memories (value, source_run_id, updated_at, key) VALUES (?, ?, ?, ?)",
                );

                write.run(fact.value, fact.sourceRunId, fact.updatedAt, fact.key);

                return fact;
              })
              .immediate(),
          catch: requestFailure,
        });
      });

    return {
      list,
      remember: (key, value, sourceRunId = null) => saveMemory(key, value, sourceRunId, "remember"),
      replace: (key, value, sourceRunId = null) => saveMemory(key, value, sourceRunId, "replace"),
      forget: (key) =>
        Effect.try({
          try: () => {
            Schema.decodeUnknownSync(MemoryFact.fields.key)(key);
            using statement = database.prepare("DELETE FROM memories WHERE key = ?");

            if (statement.run(key).changes === 0)
              throw new MemoryError({ reason: "not-found", message: "The fact does not exist." });
          },
          catch: requestFailure,
        }),
      snapshot: (limits) =>
        Effect.gen(function* () {
          const budget = yield* Schema.decodeUnknownEffect(SnapshotLimits, {
            onExcessProperty: "error",
          })(limits).pipe(Effect.mapError(requestFailure));

          const soul = yield* readContext("SOUL.md", budget.soulBytes, "POPPET_SOUL_BYTES");

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
