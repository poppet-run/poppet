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

export const MemoryFact = Schema.Struct({
  key: MemoryKey,
  value: MemoryValue,
  sourceRunId: Schema.NullOr(
    Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  ),
  updatedAt: Schema.Natural,
});

export type MemoryFact = typeof MemoryFact.Type;

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
