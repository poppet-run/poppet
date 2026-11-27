import type { Agent, Skills } from "@poppet/agent";
import { ChatSettings, logChatDiagnostic } from "@poppet/agent";
import type { AgentError } from "@poppet/agent";
import type { AppConfig } from "@poppet/config";
import type { MCP } from "@poppet/mcp";
import { MCPCommand, inspectMCP } from "@poppet/mcp";
import type { Memory } from "@poppet/memory";
import { Session, Store } from "@poppet/store";
import {
  WorkerRequests,
  WorkerRequestError,
  requestWorker,
  requestWorkerReply,
  workerReply,
} from "@poppet/worker";
import type { Cause } from "effect";
import { Effect, Exit, Layer, Option, Queue, Schema, Stream, Scope } from "effect";
import type { SqlClient } from "effect/sql";

import { ApprovalCommand, manageApprovals } from "#src/commands/approvals/approvals";
import { ChatInspection, ChatSubmission, inspectChat, sendChat } from "#src/commands/chat/chat";
import type { ChatWriter, ChatReasoning, ChatReasoningWriter } from "#src/commands/chat/chat";
import { MemoryCommand, manageMemory } from "#src/commands/memory/memory";

const WorkerChat = Schema.Struct({
  kind: Schema.Literal("chat"),
  command: ChatSubmission,
  streamReasoning: Schema.optionalKey(Schema.Boolean),
});

const WorkerQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("approvals"), command: ApprovalCommand }),
  Schema.Struct({ kind: Schema.Literal("chat"), command: ChatInspection }),
  Schema.Struct({ kind: Schema.Literal("memory"), command: MemoryCommand }),
  Schema.Struct({ kind: Schema.Literal("store") }),
  Schema.Struct({ kind: Schema.Literal("mcp"), command: MCPCommand }),
]);

export type WorkerQuery = typeof WorkerQuery.Type;

const Frame = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
    sessionId: Schema.optionalKey(Session.fields.id),
  }),
  Schema.Struct({ type: Schema.Literal("reasoning-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning-end") }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
]);

type Frame = typeof Frame.Type;

const answer = (request: WorkerQuery) =>
  Effect.gen(function* () {
    if (request.kind === "approvals") {
      return yield* manageApprovals(request.command);
    }

    if (request.kind === "mcp") {
      return yield* inspectMCP(request.command);
    }

    if (request.kind === "memory") {
      return yield* manageMemory(request.command);
    }

    if (request.kind === "store") {
      return yield* Store.use((store) => store.status);
    }

    return yield* inspectChat(request.command, (yield* ChatSettings).toolBytes);
  });

export const WorkerRequestsLive = Layer.effect(
  WorkerRequests,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Agent | AppConfig | Store | SqlClient.SqlClient | Memory | ChatSettings | Skills | MCP
    >();

    return {
      handle: (request, payload): Effect.Effect<Response, never, Scope.Scope> =>
        Effect.gen(function* () {
          const route = new URL(request.url).pathname;

          if (route === "/v1/queries") {
            return yield* workerReply(
              Schema.decodeUnknownEffect(WorkerQuery, { onExcessProperty: "error" })(payload).pipe(
                Effect.mapError(() => ({ message: "Invalid worker command." })),
                Effect.flatMap(answer),
                Effect.provide(services),
              ),
              "The worker command failed.",
            );
          }

          if (route !== "/v1/commands") {
            return new Response("Not found", { status: 404 });
          }

          const command = Schema.decodeUnknownOption(WorkerChat, { onExcessProperty: "error" })(
            payload,
          );

          if (Option.isNone(command)) {
            return Response.json(
              { ok: false, message: "Invalid worker command." },
              { status: 400 },
            );
          }

          if (request.signal.aborted) {
            return new Response(null, { status: 499 });
          }

          const owned = yield* Scope.fork(yield* Effect.scope);
          const frames = yield* Queue.make<Frame, Cause.Done>({ capacity: 16 });
          const emitFrame = (frame: Frame) => Queue.offer(frames, frame).pipe(Effect.asVoid);

          const onAbort = () => {
            void Effect.runFork(Scope.close(owned, Exit.void));
          };

          request.signal.addEventListener("abort", onAbort, { once: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => request.signal.removeEventListener("abort", onAbort)),
          ).pipe(Effect.provideService(Scope.Scope, owned));

          if (request.signal.aborted) {
            yield* Scope.close(owned, Exit.void);

            return new Response(null, { status: 499 });
          }

          const logDiagnostic = (text: string) =>
            logChatDiagnostic(text).pipe(Effect.andThen(emitFrame({ type: "stderr", text })));

          const reasoning: ChatReasoning = command.value.streamReasoning
            ? {
                log: () => Effect.void,
                write: emitFrame,
              }
            : { log: logDiagnostic };

          yield* sendChat(
            command.value.command,
            (text) => emitFrame({ type: "stdout", text }),
            (text, sessionId) =>
              emitFrame(
                sessionId === undefined
                  ? { type: "stderr", text }
                  : { type: "stderr", text, sessionId },
              ),
            reasoning,
            logDiagnostic,
          ).pipe(
            Effect.provide(services),
            Effect.matchEffect({
              onFailure: (error) => emitFrame({ type: "failed", message: error.message }),
              onSuccess: () => emitFrame({ type: "done" }),
            }),
            Effect.ensuring(Queue.end(frames)),
            Effect.forkIn(owned),
          );

          yield* Effect.addFinalizer(() => Queue.end(frames)).pipe(
            Effect.provideService(Scope.Scope, owned),
          );

          const signal = yield* Effect.abortSignal.pipe(Effect.provideService(Scope.Scope, owned));
          const context = yield* Effect.context<never>();
          const encoder = new TextEncoder();

          const body = Stream.fromQueue(frames).pipe(
            Stream.onExit((exit) => Scope.close(owned, exit)),
            Stream.map((frame) => encoder.encode(`${JSON.stringify(frame)}\n`)),
            Stream.toReadableStreamWith(context, { signal }),
          );

          return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
        }),
    };
  }),
);

const lost =
  "Lost the worker response. The command was not retried; inspect the saved session or memory before trying again.";

const lostResponse = () => new WorkerRequestError({ message: lost });

export const remoteWorkerQuery = (path: string, query: WorkerQuery) =>
  requestWorkerReply(path, "/v1/queries", query, lost);

export const remoteWorkerCommand = (
  path: string,
  command: ChatSubmission,
  write: ChatWriter,
  onSession: ChatWriter = () => Effect.void,
  writeReasoning?: ChatReasoningWriter,
  announce: ChatWriter = logChatDiagnostic,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopedSignal = yield* Effect.abortSignal;

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          requestWorker(
            path,
            "/v1/commands",
            { kind: "chat", command, streamReasoning: writeReasoning !== undefined },
            AbortSignal.any([signal, scopedSignal]),
          ),
        catch: (cause) => (cause instanceof WorkerRequestError ? cause : lostResponse()),
      });

      if (response === null) {
        return false;
      }

      if (
        !response.ok ||
        response.body === null ||
        response.headers.get("content-type") !== "application/x-ndjson"
      ) {
        return yield* Effect.fail(
          new WorkerRequestError({
            message:
              "The worker rejected this command. Check its arguments; if the worker is outdated, restart it to load the current code. The command was not retried.",
          }),
        );
      }

      const body = response.body;
      let done = false;

      yield* Stream.fromReadableStream({ evaluate: () => body, onError: lostResponse }).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.mapEffect((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))(line).pipe(
            Effect.mapError(lostResponse),
          ),
        ),
        Stream.runForEach((frame): Effect.Effect<void, WorkerRequestError | AgentError> => {
          if (done) {
            return Effect.fail(lostResponse());
          }

          if (frame.type === "failed") {
            return Effect.fail(new WorkerRequestError({ message: frame.message }));
          }

          if (frame.type === "done") {
            return Effect.sync(() => {
              done = true;
            });
          }

          if (frame.type === "reasoning-delta" || frame.type === "reasoning-end") {
            return writeReasoning?.(frame) ?? Effect.void;
          }

          if (frame.type === "stderr") {
            return Effect.gen(function* () {
              if (frame.sessionId !== undefined) {
                yield* onSession(frame.sessionId);
              }

              yield* announce(frame.text);
            });
          }

          return write(frame.text);
        }),
      );

      if (!done) {
        return yield* Effect.fail(lostResponse());
      }

      return true;
    }),
  );
