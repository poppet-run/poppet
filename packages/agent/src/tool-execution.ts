import { measureTiming } from "@poppet/provider";
import { Store, StoreError, type Run } from "@poppet/store";
import { Effect } from "effect";

import {
  reportedReasons,
  reportedStoreReasons,
  type AgentTool,
  type FailurePolicy,
  type PreparedCall,
} from "#src/agent-tool";
import { AgentError } from "#src/errors";

export const failureReason = (error: AgentError | StoreError) =>
  `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`;

/** Classifies an execution failure by the tool's policy; see `FailurePolicy`. */
export const toolFailureKind = (
  failures: FailurePolicy,
  error: AgentError | StoreError,
): "reported" | "uncertain" | "fatal" => {
  const reason = failureReason(error);

  if (failures.reported.has(reason)) return "reported";

  return failures.uncertain.has(reason) ? "uncertain" : failures.otherwise;
};

/** Preparation runs before any effect, so its failures are reportable unless storage failed. */
export const preflightReported = (error: AgentError | StoreError) =>
  error instanceof StoreError
    ? reportedStoreReasons.has(error.reason)
    : reportedReasons.has(error.reason);

export const failureReply = (reason: string, message: string) =>
  JSON.stringify({ error: { reason, message } });

export const toolExecution = Effect.gen(function* () {
  const store = yield* Store;

  return (
    run: Run,
    callId: string,
    tool: AgentTool,
    call: PreparedCall,
    guard: (output: string) => Effect.Effect<void, AgentError>,
  ) => {
    const operation = Effect.gen(function* () {
      yield* store.startToolCall(run.id, callId);

      const outcome = yield* measureTiming("tool", call.execute).pipe(
        Effect.tap((output) => (tool.contextOnly ? guard(output) : Effect.void)),
        Effect.map((output) => ({ output, reported: false })),
        Effect.catch((error) => {
          const kind = toolFailureKind(tool.failures, error);

          if (kind === "reported") {
            const output = failureReply(error.reason, error.message);

            return store
              .finishToolCall(run.id, callId, {
                status: "failed",
                reason: failureReason(error),
                output,
              })
              .pipe(Effect.as({ output, reported: true }));
          }

          if (tool.failures.journalFatalReply === true && kind === "fatal")
            return store
              .finishToolCall(run.id, callId, {
                status: "failed",
                reason: failureReason(error),
                output: failureReply(error.reason, error.message),
              })
              .pipe(Effect.andThen(Effect.fail(error)));

          return store
            .finishToolCall(run.id, callId, {
              status: kind === "uncertain" ? "uncertain" : "failed",
              reason: failureReason(error),
            })
            .pipe(Effect.andThen(Effect.fail(error)));
        }),
      );

      if (!outcome.reported && tool.recordsOwnResult !== true)
        yield* store.finishToolCall(run.id, callId, {
          status: "completed",
          output: outcome.output,
        });

      return {
        output: outcome.output,
        urls: outcome.reported ? [] : (call.grantedURLs?.() ?? []),
      };
    });

    return tool.uninterruptible === true ? Effect.uninterruptible(operation) : operation;
  };
});
