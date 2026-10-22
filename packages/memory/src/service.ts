import { Context, Data, type Effect } from "effect";

import type { MemoryFact, MemorySnapshot, SnapshotLimits } from "#src/schema";

/** Distinguishes invalid memory requests, missing facts, budget limits, and storage failures. */
export class MemoryError extends Data.TaggedError("MemoryError")<{
  readonly reason: "storage" | "corrupt" | "invalid-request" | "not-found" | "conflict" | "limit";
  readonly message: string;
}> {}

interface MemoryOperations {
  readonly forProject?: (name: string) => MemoryOperations;
  /** Reads prompt files and saved facts, failing rather than truncating content over budget. */
  readonly snapshot: (limits: SnapshotLimits) => Effect.Effect<MemorySnapshot, MemoryError>;
  readonly list: Effect.Effect<ReadonlyArray<MemoryFact>, MemoryError>;
  /** Creates a fact; an existing key is a conflict rather than an implicit overwrite. */
  readonly remember: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, MemoryError>;
  /** Updates an existing fact; a missing key is an error. */
  readonly replace: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, MemoryError>;
  /** Removes a saved fact; a missing key is an error. */
  readonly forget: (key: string) => Effect.Effect<void, MemoryError>;
}

/** Explicit fact storage and bounded prompt context, separate from conversation history. */
export class Memory extends Context.Service<Memory, MemoryOperations>()("poppet/Memory") {}
