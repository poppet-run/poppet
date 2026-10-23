import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { ProjectName, StoreDatabase } from "@poppet/store";
import { DateTime, Effect, Layer, Schema } from "effect";

import { memoryLimit, readContextFile } from "#src/context-file";
import { MemoryFact, MemoryRevision, SnapshotLimits, type MemoryOrigin } from "#src/schema";
import { Memory, MemoryError } from "#src/service";

const memorySql = `SELECT key, value, origin, source_run_id AS sourceRunId, updated_at AS updatedAt FROM memories`;

const revisionSql = `SELECT key, revision, action, value, origin, source_run_id AS sourceRunId, created_at AS createdAt FROM memory_revisions`;

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

    const scoped = (project: string): Memory["Service"] => {
      const list = Effect.try({
        try: () =>
          readRecord(() => {
            using statement = database.prepare(`${memorySql} WHERE project = ? ORDER BY key`);

            return Schema.decodeUnknownSync(Schema.Array(MemoryFact))(statement.all(project));
          }),
        catch: requestFailure,
      });

      const current = (key: string) => {
        using select = database.prepare(`${memorySql} WHERE project = ? AND key = ?`);

        return readRecord(() =>
          Schema.decodeUnknownSync(Schema.NullOr(MemoryFact))(select.get(project, key)),
        );
      };

      const requireSource = (sourceRunId: string | null) => {
        if (sourceRunId === null) return;

        using source = database.prepare(
          "SELECT runs.id FROM runs JOIN sessions ON sessions.id = runs.session_id WHERE runs.id = ? AND COALESCE(json_extract(sessions.project, '$.name'), '') = ?",
        );

        if (source.get(sourceRunId, project) === null)
          throw new MemoryError({
            reason: "not-found",
            message: "The source run does not exist.",
          });
      };

      const requireRoom = () => {
        using count = database.prepare("SELECT COUNT(*) AS count FROM memories WHERE project = ?");

        const total = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(
          count.get(project),
        ).count;

        if (total >= 128)
          throw new MemoryError({
            reason: "conflict",
            message: "Memory holds at most 128 facts. Forget a fact before adding another.",
          });
      };

      // Runs inside the caller's transaction so the fact and its revision change together.
      const commit = (
        key: string,
        action: MemoryRevision["action"],
        value: string | null,
        sourceRunId: string | null,
        origin: MemoryOrigin,
        at: number,
      ): MemoryFact | null => {
        const existing = current(key);

        using next = database.prepare(
          "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_revisions WHERE project = ? AND key = ?",
        );

        const revision = Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.Int }))(
          next.get(project, key),
        ).revision;

        using record = database.prepare(
          "INSERT INTO memory_revisions (project, key, revision, action, value, origin, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );

        record.run(project, key, revision, action, value, origin, sourceRunId, at);

        if (value === null) {
          using remove = database.prepare("DELETE FROM memories WHERE project = ? AND key = ?");
          remove.run(project, key);

          return null;
        }

        const fact = Schema.decodeUnknownSync(MemoryFact, { onExcessProperty: "error" })({
          key,
          value,
          origin,
          sourceRunId,
          updatedAt: Math.max(at, existing?.updatedAt ?? 0),
        });

        using write = database.prepare(
          existing === null
            ? "INSERT INTO memories (value, origin, source_run_id, updated_at, project, key) VALUES (?, ?, ?, ?, ?, ?)"
            : "UPDATE memories SET value = ?, origin = ?, source_run_id = ?, updated_at = ? WHERE project = ? AND key = ?",
        );

        write.run(fact.value, fact.origin, fact.sourceRunId, fact.updatedAt, project, fact.key);

        return fact;
      };

      const transaction = <A>(run: (at: number) => A) =>
        Effect.gen(function* () {
          const at = (yield* DateTime.nowAsDate).getTime();

          return yield* Effect.try({
            try: () => database.transaction(() => run(at)).immediate(),
            catch: requestFailure,
          });
        });

      const saveMemory = (
        key: string,
        value: string,
        sourceRunId: string | null,
        mode: "remember" | "replace",
      ) =>
        transaction((at) => {
          Schema.decodeUnknownSync(MemoryFact.fields.key)(key);
          Schema.decodeUnknownSync(MemoryFact.fields.value)(value);
          const resolved = sourceRunId === null ? "cli" : "turn";
          requireSource(sourceRunId);
          const existing = current(key);

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

          if (mode === "remember") requireRoom();

          return commit(key, mode, value, sourceRunId, resolved, at)!;
        });

      return {
        forProject: (name) => scoped(Schema.decodeUnknownSync(ProjectName)(name)),
        list,
        remember: (key, value, sourceRunId = null) =>
          saveMemory(key, value, sourceRunId, "remember"),
        replace: (key, value, sourceRunId = null) => saveMemory(key, value, sourceRunId, "replace"),
        forget: (key, sourceRunId = null) =>
          transaction((at) => {
            Schema.decodeUnknownSync(MemoryFact.fields.key)(key);
            const resolved = sourceRunId === null ? "cli" : "turn";
            requireSource(sourceRunId);

            if (current(key) === null)
              throw new MemoryError({ reason: "not-found", message: "The fact does not exist." });

            commit(key, "forget", null, sourceRunId, resolved, at);
          }),
        history: (key) =>
          Effect.try({
            try: () => {
              Schema.decodeUnknownSync(MemoryFact.fields.key)(key);

              using statement = database.prepare(
                `${revisionSql} WHERE project = ? AND key = ? ORDER BY revision`,
              );

              return readRecord(() =>
                Schema.decodeUnknownSync(Schema.Array(MemoryRevision))(statement.all(project, key)),
              );
            },
            catch: requestFailure,
          }),
        revert: (key, revision) =>
          transaction((at) => {
            Schema.decodeUnknownSync(MemoryFact.fields.key)(key);

            using statement = database.prepare(
              `${revisionSql} WHERE project = ? AND key = ? AND revision = ?`,
            );

            const target = readRecord(() =>
              Schema.decodeUnknownSync(Schema.NullOr(MemoryRevision))(
                statement.get(project, key, revision),
              ),
            );

            if (target === null)
              throw new MemoryError({
                reason: "not-found",
                message: "The fact revision does not exist.",
              });

            const existing = current(key);

            if (target.value === null) {
              if (existing === null)
                throw new MemoryError({
                  reason: "conflict",
                  message: "The fact is already forgotten.",
                });

              return commit(key, "forget", null, null, "cli", at);
            }

            if (existing?.value === target.value)
              throw new MemoryError({
                reason: "conflict",
                message: "The fact already has this value.",
              });

            if (existing === null) requireRoom();

            return commit(key, "revert", target.value, null, "cli", at);
          }),
        snapshot: (limits) =>
          Effect.gen(function* () {
            const budget = yield* Schema.decodeUnknownEffect(SnapshotLimits, {
              onExcessProperty: "error",
            })(limits).pipe(Effect.mapError(requestFailure));

            const soul = project
              ? ""
              : yield* readContext("soul.md", budget.soulBytes, "POPPET_SOUL_BYTES");

            const profile = project
              ? ""
              : yield* readContext("profile.md", budget.profileBytes, "POPPET_PROFILE_BYTES");

            const facts = (yield* list).map(({ key, value }) => ({ key, value }));

            if (
              facts.length > 0 &&
              Buffer.byteLength(JSON.stringify(facts), "utf8") > budget.factsBytes
            )
              return yield* Effect.fail(
                project
                  ? new MemoryError({
                      reason: "limit",
                      message: `Project facts exceed the ${budget.factsBytes}-byte snapshot limit. Shorten or forget a project fact.`,
                    })
                  : memoryLimit("saved facts", "POPPET_FACTS_BYTES"),
              );

            return { soul, profile, facts };
          }),
      } satisfies Memory["Service"];
    };

    return scoped("");
  }),
);
