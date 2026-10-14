import { Context, Data, type Effect } from "effect";

import type { MemoryFact, MemorySnapshot, SnapshotLimits } from "#src/schema";

export class MemoryError extends Data.TaggedError("MemoryError")<{
  readonly reason: "storage" | "corrupt" | "invalid-request" | "not-found" | "conflict" | "limit";
  readonly message: string;
}> {}

interface MemoryOperations {
  readonly snapshot: (limits: SnapshotLimits) => Effect.Effect<MemorySnapshot, MemoryError>;
  readonly list: Effect.Effect<ReadonlyArray<MemoryFact>, MemoryError>;
  readonly remember: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, MemoryError>;
  readonly replace: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, MemoryError>;
  readonly forget: (key: string) => Effect.Effect<void, MemoryError>;
}

export class Memory extends Context.Service<Memory, MemoryOperations>()("poppet/Memory") {}
