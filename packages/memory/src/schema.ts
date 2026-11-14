import { Schema } from "effect";

export const MemoryKey = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
);

export const MemoryValue = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.makeFilter(
    (value) => Buffer.byteLength(value, "utf8") <= 4096 || "Use at most 4096 UTF-8 bytes.",
  ),
);

const RunId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

export const MemoryOrigin = Schema.Literals(["cli", "turn"]);

export type MemoryOrigin = typeof MemoryOrigin.Type;

export const MemoryFact = Schema.Struct({
  key: MemoryKey,
  value: MemoryValue,
  origin: MemoryOrigin,
  sourceRunId: Schema.NullOr(RunId),
  updatedAt: Schema.Natural,
});

export type MemoryFact = typeof MemoryFact.Type;

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

export const SnapshotLimits = Schema.Struct({
  soulBytes: Bytes,
  profileBytes: Bytes,
  factsBytes: Bytes,
});

export type SnapshotLimits = typeof SnapshotLimits.Type;

export const MemorySnapshot = Schema.Struct({
  soul: Schema.String,
  profile: Schema.String,
  facts: Schema.Array(Schema.Struct({ key: MemoryKey, value: MemoryValue })),
});

export type MemorySnapshot = typeof MemorySnapshot.Type;
