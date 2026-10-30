import { Effect, Layer } from "effect";

import { MCPSignIns } from "#src/oauth";

/** Servers without OAuth never read sign-in records. */
export const NoSignInsLive = Layer.succeed(MCPSignIns, {
  read: () => Effect.die("Unexpected sign-in read"),
  update: () => Effect.die("Unexpected sign-in update"),
});
