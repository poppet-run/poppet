import { measureTiming } from "@poppet/provider";
import { Store, StoreError } from "@poppet/store";
import type { Run } from "@poppet/store";
import { Effect } from "effect";

import type { ParkRequest } from "#src/action-approval";
import { reportedReasons, reportedStoreReasons } from "#src/agent-tool";
import type { AgentTool, FailurePolicy, PreparedCall, ReviewableCall } from "#src/agent-tool";
import { AgentError } from "#src/errors";

export const failureReason = (error: AgentError | StoreError) =>
  `${error instanceof AgentError ? "agent" : "store"}:${error.reason}`;

export const toolFailureKind = (
  failures: FailurePolicy,
  error: AgentError | StoreError,
): "reported" | "uncertain" | "fatal" => {
  const reason = failureReason(error);

  if (failures.reported.has(reason)) {
    return "reported";
  }

  return failures.uncertain.has(reason) ? "uncertain" : failures.otherwise;
};

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
    call: PreparedCall | ReviewableCall,
    guard: (output: string) => Effect.Effect<void, AgentError>,
  ) => {
    const operation = Effect.gen(function* () {
      const failCall = (error: AgentError | StoreError) => {
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

        if (tool.failures.journalFatalReply === true && kind === "fatal") {
          return store
            .finishToolCall(run.id, callId, {
              status: "failed",
              reason: failureReason(error),
              output: failureReply(error.reason, error.message),
            })
            .pipe(Effect.andThen(Effect.fail(error)));
        }

        return store
          .finishToolCall(run.id, callId, {
            status: kind === "uncertain" ? "uncertain" : "failed",
            reason: failureReason(error),
          })
          .pipe(Effect.andThen(Effect.fail(error)));
      };

      const authorized =
        "authorize" in call
          ? yield* call
              .authorize((review) => store.recordToolReview(run.id, callId, review))
              .pipe(
                // A park request leaves the call pending for the owner's decision.
                Effect.catch((error): Effect.Effect<never, AgentError | StoreError | ParkRequest> =>
                  error instanceof AgentError
                    ? store
                        .finishToolCall(run.id, callId, {
                          status: "failed",
                          reason: failureReason(error),
                          output: failureReply(error.reason, error.message),
                        })
                        .pipe(Effect.andThen(Effect.fail(error)))
                    : Effect.fail(error),
                ),
              )
          : call;

      yield* store.startToolCall(run.id, callId);

      const outcome = yield* measureTiming("tool", authorized.execute).pipe(
        Effect.tap((output) => (tool.contextOnly ? guard(output) : Effect.void)),
        Effect.map((output) => ({ output, reported: false })),
        Effect.catch(failCall),
      );

      if (!outcome.reported && tool.recordsOwnResult !== true) {
        yield* store.finishToolCall(run.id, callId, {
          status: "completed",
          output: outcome.output,
        });
      }

      return outcome.output;
    });

    return tool.uninterruptible === true ? Effect.uninterruptible(operation) : operation;
  };
});
