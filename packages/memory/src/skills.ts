import { SkillName, SkillSnapshot, StoreDatabase } from "@poppet/store";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { MemoryError } from "#src/service";

/** Learned skill Markdown: nonempty, at most 8192 UTF-8 bytes, and free of NUL bytes. */
export const LearnedSkillContent = SkillSnapshot.fields.content.check(
  Schema.makeFilter((text) => text.trim().length > 0 || "Use nonempty skill content."),
);

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const RunId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

/** The current text of a skill Poppet wrote; owner files with the same name take precedence. */
export const LearnedSkill = Schema.Struct({
  name: SkillName,
  revision: Revision,
  content: LearnedSkillContent,
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
});

export type LearnedSkill = typeof LearnedSkill.Type;

export const SkillOrigin = Schema.Literals(["owner", "turn", "review"]);

export type SkillOrigin = typeof SkillOrigin.Type;

/** One append-only history entry; a deletion keeps its tombstone so it can be reverted. */
export const SkillRevision = Schema.Struct({
  name: SkillName,
  revision: Revision,
  action: Schema.Literals(["create", "patch", "replace", "delete", "revert"]),
  content: Schema.NullOr(LearnedSkillContent),
  origin: SkillOrigin,
  sourceRunId: Schema.NullOr(RunId),
  sourceCallId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});

export type SkillRevision = typeof SkillRevision.Type;

/** A change requested by the owner or the model; non-create changes may require a revision. */
export type SkillChange =
  | { readonly action: "create"; readonly name: string; readonly content: string }
  | {
      readonly action: "replace";
      readonly name: string;
      readonly content: string;
      readonly expectedRevision?: number;
    }
  | {
      readonly action: "patch";
      readonly name: string;
      readonly old: string;
      readonly new: string;
      readonly expectedRevision?: number;
    }
  | { readonly action: "delete"; readonly name: string; readonly expectedRevision?: number };

/** Host-supplied provenance; model arguments never choose an origin or source. */
export type SkillSource =
  | { readonly origin: "owner" }
  | { readonly origin: "turn" | "review"; readonly runId: string; readonly callId: string };

export interface SkillReceipt {
  readonly name: string;
  readonly revision: number;
  readonly action: SkillRevision["action"];
  readonly deleted: boolean;
}

/** Learned procedures with revision history, stored beside conversations and facts. */
export class LearnedSkills extends Context.Service<
  LearnedSkills,
  {
    readonly list: Effect.Effect<ReadonlyArray<LearnedSkill>, MemoryError>;
    readonly get: (name: string) => Effect.Effect<LearnedSkill | null, MemoryError>;
    readonly history: (name: string) => Effect.Effect<ReadonlyArray<SkillRevision>, MemoryError>;
    readonly write: (
      change: SkillChange,
      source: SkillSource,
    ) => Effect.Effect<SkillReceipt, MemoryError>;
    /** Restores an earlier revision as a new one; restoring a tombstone deletes the skill. */
    readonly revert: (name: string, revision: number) => Effect.Effect<SkillReceipt, MemoryError>;
  }
>()("poppet/LearnedSkills") {}

export const maxLearnedSkills = 64;

// Recognizable credential shapes; model-written skills must not persist secrets.
const secretPatterns: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u,
];

export const containsSecret = (content: string) =>
  secretPatterns.some((pattern) => pattern.test(content));

const skillSql =
  "SELECT name, revision, content, created_at AS createdAt, updated_at AS updatedAt FROM learned_skills";

const revisionSql =
  "SELECT name, revision, action, content, origin, source_run_id AS sourceRunId, source_call_id AS sourceCallId, created_at AS createdAt FROM skill_revisions";

const fail = (reason: MemoryError["reason"], message: string) => {
  throw new MemoryError({ reason, message });
};

const failure = (cause: unknown) => {
  if (cause instanceof MemoryError) return cause;

  return new MemoryError({
    reason: cause instanceof Schema.SchemaError ? "invalid-request" : "storage",
    message:
      cause instanceof Schema.SchemaError
        ? "The learned skill request is invalid."
        : "Poppet could not read or write its learned skills.",
  });
};

const readRecord = <A>(read: () => A): A => {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof Schema.SchemaError)
      return fail("corrupt", "The learned skill store contains an invalid record.");
    throw cause;
  }
};

const validContent = (content: string, source: SkillSource) => {
  Schema.decodeUnknownSync(LearnedSkillContent)(content);

  if (source.origin !== "owner" && containsSecret(content))
    fail(
      "invalid-request",
      "The skill appears to contain a credential. Remove secrets and use inputs instead.",
    );

  return content;
};

// The host supplies the same scoped database used by conversation storage.
export const LearnedSkillsLive = Layer.effect(
  LearnedSkills,
  Effect.gen(function* () {
    const { database } = yield* StoreDatabase;

    const current = (name: string) => {
      using statement = database.prepare(`${skillSql} WHERE name = ?`);

      return readRecord(() =>
        Schema.decodeUnknownSync(Schema.NullOr(LearnedSkill))(statement.get(name)),
      );
    };

    const nextRevision = (name: string) => {
      using statement = database.prepare(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM skill_revisions WHERE name = ?",
      );

      return readRecord(() =>
        Schema.decodeUnknownSync(Schema.Struct({ revision: Revision }))(statement.get(name)),
      ).revision;
    };

    // Runs inside the caller's transaction so the revision and current text change together.
    const commit = (
      name: string,
      action: SkillRevision["action"],
      content: string | null,
      source: SkillSource,
      at: number,
    ): SkillReceipt => {
      const existing = current(name);
      const revision = nextRevision(name);
      const runId = source.origin === "owner" ? null : source.runId;
      const callId = source.origin === "owner" ? null : source.callId;

      if (runId !== null) {
        using run = database.prepare("SELECT id FROM runs WHERE id = ?");

        if (run.get(runId) === null) fail("not-found", "The source run does not exist.");

        using duplicate = database.prepare(
          "SELECT 1 FROM skill_revisions WHERE source_run_id = ? AND source_call_id = ?",
        );

        if (duplicate.get(runId, callId) !== null)
          fail("conflict", "This tool call already changed a skill.");
      }

      using record = database.prepare(
        "INSERT INTO skill_revisions (name, revision, action, content, origin, source_run_id, source_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );

      record.run(name, revision, action, content, source.origin, runId, callId, at);

      if (content === null) {
        using remove = database.prepare("DELETE FROM learned_skills WHERE name = ?");
        remove.run(name);
      } else if (existing === null) {
        using insert = database.prepare(
          "INSERT INTO learned_skills (name, revision, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        );

        insert.run(name, revision, content, at, at);
      } else {
        using update = database.prepare(
          "UPDATE learned_skills SET revision = ?, content = ?, updated_at = ? WHERE name = ?",
        );

        update.run(revision, content, Math.max(at, existing.updatedAt), name);
      }

      return { name, revision, action, deleted: content === null };
    };

    const requireCount = () => {
      using count = database.prepare("SELECT COUNT(*) AS count FROM learned_skills");

      if (
        readRecord(() =>
          Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(count.get()),
        ).count >= maxLearnedSkills
      )
        fail(
          "limit",
          `Poppet keeps at most ${maxLearnedSkills} learned skills. Delete or patch an existing skill instead.`,
        );
    };

    const transaction = <A>(run: (at: number) => A) =>
      Effect.gen(function* () {
        const at = (yield* DateTime.nowAsDate).getTime();

        return yield* Effect.try({
          try: () => database.transaction(() => run(at)).immediate(),
          catch: failure,
        });
      });

    const write = (change: SkillChange, source: SkillSource) =>
      transaction((at) => {
        const name = Schema.decodeUnknownSync(SkillName)(change.name);
        const existing = current(name);

        if (change.action === "create") {
          if (existing !== null)
            fail("conflict", "The learned skill already exists. Patch or replace it instead.");
          requireCount();

          return commit(name, "create", validContent(change.content, source), source, at);
        }

        if (existing === null) return fail("not-found", "The learned skill does not exist.");

        if (change.expectedRevision !== undefined && change.expectedRevision !== existing.revision)
          fail(
            "conflict",
            `The skill changed since revision ${change.expectedRevision}; it is now revision ${existing.revision}. View it again before changing it.`,
          );

        if (change.action === "delete") return commit(name, "delete", null, source, at);

        if (change.action === "replace")
          return commit(name, "replace", validContent(change.content, source), source, at);

        const matches = change.old.length === 0 ? 0 : existing.content.split(change.old).length - 1;

        if (matches !== 1)
          fail(
            "invalid-request",
            matches === 0
              ? "The text to replace was not found in the skill."
              : "The text to replace matches more than once. Include more surrounding text.",
          );

        const content = existing.content.replace(change.old, () => change.new);

        return commit(name, "patch", validContent(content, source), source, at);
      });

    return {
      list: Effect.try({
        try: () => {
          using statement = database.prepare(`${skillSql} ORDER BY name`);

          return readRecord(() =>
            Schema.decodeUnknownSync(Schema.Array(LearnedSkill))(statement.all()),
          );
        },
        catch: failure,
      }),
      get: (name) =>
        Effect.try({
          try: () => current(Schema.decodeUnknownSync(SkillName)(name)),
          catch: failure,
        }),
      history: (name) =>
        Effect.try({
          try: () => {
            using statement = database.prepare(`${revisionSql} WHERE name = ? ORDER BY revision`);

            return readRecord(() =>
              Schema.decodeUnknownSync(Schema.Array(SkillRevision))(
                statement.all(Schema.decodeUnknownSync(SkillName)(name)),
              ),
            );
          },
          catch: failure,
        }),
      write,
      revert: (name, revision) =>
        transaction((at) => {
          Schema.decodeUnknownSync(SkillName)(name);
          Schema.decodeUnknownSync(Revision)(revision);

          using statement = database.prepare(`${revisionSql} WHERE name = ? AND revision = ?`);

          const target = readRecord(() =>
            Schema.decodeUnknownSync(Schema.NullOr(SkillRevision))(statement.get(name, revision)),
          );

          if (target === null) return fail("not-found", "The skill revision does not exist.");

          const existing = current(name);

          if (target.content === null) {
            if (existing === null) fail("conflict", "The skill is already deleted.");

            return commit(name, "delete", null, { origin: "owner" }, at);
          }

          if (existing?.content === target.content)
            fail("conflict", "The skill already has this content.");

          if (existing === null) requireCount();

          return commit(name, "revert", target.content, { origin: "owner" }, at);
        }),
    } satisfies LearnedSkills["Service"];
  }),
);
