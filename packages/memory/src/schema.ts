import { Schema } from "effect";

/** A stable fact name that can be addressed by memory commands. */
export const MemoryKey = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
);

/** A trimmed fact value limited to 4096 UTF-8 bytes. */
export const MemoryValue = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.makeFilter(
    (value) => Buffer.byteLength(value, "utf8") <= 4096 || "Use at most 4096 UTF-8 bytes.",
  ),
);

const RunId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

/** Who made a change: the owner through the CLI, a chat turn, or a historical background review. */
export const MemoryOrigin = Schema.Literals(["cli", "turn", "review"]);

export type MemoryOrigin = typeof MemoryOrigin.Type;

/** A saved fact with its latest origin, optional source run, and Unix millisecond update time. */
export const MemoryFact = Schema.Struct({
  key: MemoryKey,
  value: MemoryValue,
  origin: MemoryOrigin,
  sourceRunId: Schema.NullOr(RunId),
  updatedAt: Schema.Natural,
});

export type MemoryFact = typeof MemoryFact.Type;

/** One append-only fact change; forgetting keeps a null-valued revision so it can be reverted. */
export const MemoryRevision = Schema.Struct({
  key: MemoryKey,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  action: Schema.Literals(["remember", "replace", "forget", "revert"]),
  value: Schema.NullOr(MemoryValue),
  origin: MemoryOrigin,
  sourceRunId: Schema.NullOr(RunId),
  createdAt: Schema.Natural,
});

export type MemoryRevision = typeof MemoryRevision.Type;

const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 }));

/** Separate UTF-8 byte budgets for the files and facts loaded into a run's prompt. */
export const SnapshotLimits = Schema.Struct({
  soulBytes: Bytes,
  profileBytes: Bytes,
  factsBytes: Bytes,
});

export type SnapshotLimits = typeof SnapshotLimits.Type;

/** Prompt content read at run start, without storage metadata. */
export const MemorySnapshot = Schema.Struct({
  soul: Schema.String,
  profile: Schema.String,
  facts: Schema.Array(Schema.Struct({ key: MemoryKey, value: MemoryValue })),
});

export type MemorySnapshot = typeof MemorySnapshot.Type;
