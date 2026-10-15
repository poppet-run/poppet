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

/** An explicitly saved fact with an optional source run and a Unix millisecond update time. */
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
