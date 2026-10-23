import {
  Agent,
  ChatSettings,
  logChatDiagnostic,
  Projects,
  Skills,
  type AgentError,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { MCP, MCPCommand, inspectMCP } from "@poppet/mcp";
import { Memory } from "@poppet/memory";
import { Session, Store } from "@poppet/store";
import { WorkerRequests, WorkerRequestError, requestWorker } from "@poppet/worker";
import { Cause, Context, Effect, Layer, Option, Queue, Schema, Stream, Scope } from "effect";

import { MessagingWorker } from "#src/channels";
import {
  ChatRequest,
  inspectChat,
  sendChat,
  type ChatWriter,
  type ChatAnnouncer,
  type ChatReasoning,
  type ChatReasoningWriter,
} from "#src/chat";
import { MemoryCommand, manageMemory } from "#src/memory";

const WorkerCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    command: ChatRequest,
    streamReasoning: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("memory"), command: MemoryCommand }),
  Schema.Struct({ kind: Schema.Literal("store") }),
  Schema.Struct({ kind: Schema.Literal("gateway") }),
  Schema.Struct({ kind: Schema.Literal("mcp"), command: MCPCommand }),
]);

/** Chat, memory, and inspection requests sent to the process that owns local storage. */
export type WorkerCommand = typeof WorkerCommand.Type;

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

const execute = (
  request: WorkerCommand,
  write: ChatWriter,
  announce: ChatAnnouncer,
  reasoning: ChatReasoning,
  timingLog: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (request.kind === "mcp")
      return yield* inspectMCP(request.command).pipe(Effect.flatMap((text) => write(`${text}\n`)));

    if (request.kind === "gateway") {
      const messaging = yield* Effect.serviceOption(MessagingWorker);

      const status = Option.isSome(messaging)
        ? yield* messaging.value.status
        : { enabled: false, channels: [] };

      return yield* write(
        `${JSON.stringify({ running: Option.isSome(messaging), ...status }, null, 2)}\n`,
      );
    }

    if (request.kind === "memory")
      return yield* manageMemory(request.command).pipe(
        Effect.flatMap((text) => write(`${text}\n`)),
      );

    if (request.kind === "store") {
      const store = yield* Store;

      return yield* write(`${JSON.stringify(yield* store.status, null, 2)}\n`);
    }

    const command = request.command;

    if (
      command.action === "show" ||
      command.action === "sessions" ||
      command.action === "rename" ||
      command.action === "search"
    )
      return yield* inspectChat(command, (yield* ChatSettings).toolBytes).pipe(
        Effect.flatMap((text) => write(`${text}\n`)),
      );

    return yield* sendChat(command, write, announce, reasoning, timingLog);
  });

export const WorkerRequestsLive = Layer.effect(
  WorkerRequests,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Agent | AppConfig | Store | Memory | ChatSettings | Skills | Projects | MCP
    >();

    const messaging = yield* Effect.serviceOption(MessagingWorker);

    const provided = Option.isSome(messaging)
      ? Context.add(services, MessagingWorker, messaging.value)
      : services;

    return {
      handle: (request, payload): Effect.Effect<Response, never, Scope.Scope> =>
        Effect.gen(function* () {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/commands")
            return new Response("Not found", { status: 404 });

          const command = Schema.decodeUnknownOption(WorkerCommand, { onExcessProperty: "error" })(
            payload,
          );

          if (Option.isNone(command))
            return Response.json({ message: "Invalid worker command." }, { status: 400 });

          const owned = yield* Scope.fork(yield* Effect.scope);
          const frames = yield* Queue.make<Frame, Cause.Done>({ capacity: 16 });
          const emitFrame = (frame: Frame) => Queue.offer(frames, frame).pipe(Effect.asVoid);
          const streamReasoning = command.value.kind === "chat" && command.value.streamReasoning;

          const logDiagnostic = (text: string) =>
            logChatDiagnostic(text).pipe(Effect.andThen(emitFrame({ type: "stderr", text })));

          const reasoning: ChatReasoning = streamReasoning
            ? {
                log: logChatDiagnostic,
                write: emitFrame,
              }
            : { log: logDiagnostic };

          yield* execute(
            command.value,
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
            Effect.provide(provided),
            Effect.matchEffect({
              onFailure: (error) => emitFrame({ type: "failed", message: error.message }),
              onSuccess: () => emitFrame({ type: "done" }),
            }),
            Effect.ensuring(Queue.end(frames)),
            Effect.forkIn(owned),
          );

          // Close the queue before producer cleanup can try to forward its last diagnostic.
          yield* Effect.addFinalizer(() => Queue.end(frames)).pipe(
            Effect.provideService(Scope.Scope, owned),
          );

          const disconnected = Effect.callback<void>((resume) => {
            const abort = () => resume(Effect.void);

            if (request.signal.aborted) abort();
            else request.signal.addEventListener("abort", abort, { once: true });

            return Effect.sync(() => request.signal.removeEventListener("abort", abort));
          });

          // Own the body as well as its producer, so shutdown also ends idle HTTP responses.
          const signal = yield* Effect.abortSignal.pipe(Effect.provideService(Scope.Scope, owned));

          const context = yield* Effect.context<never>();
          const encoder = new TextEncoder();

          const body = Stream.fromQueue(frames).pipe(
            Stream.interruptWhen(disconnected),
            Stream.onExit((exit) => Scope.close(owned, exit)),
            Stream.map((frame) => encoder.encode(`${JSON.stringify(frame)}\n`)),
            Stream.toReadableStreamWith(context, { signal }),
          );

          return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
        }),
    };
  }),
);

const lostResponse = () =>
  new WorkerRequestError({
    message:
      "Lost the worker response. The command was not retried; inspect the saved session or memory before trying again.",
  });

/** Streams worker output; only a terminal frame confirms completion, and lost replies are not replayed. */
export const remoteWorkerCommand = (
  path: string,
  command: WorkerCommand,
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
            command.kind === "chat" && writeReasoning !== undefined
              ? { ...command, streamReasoning: true }
              : command,
            AbortSignal.any([signal, scopedSignal]),
          ),
        catch: (cause) => (cause instanceof WorkerRequestError ? cause : lostResponse()),
      });

      if (response === null) return false;

      if (
        !response.ok ||
        response.body === null ||
        response.headers.get("content-type") !== "application/x-ndjson"
      )
        return yield* Effect.fail(
          new WorkerRequestError({
            message:
              "The worker rejected this command. Check its arguments; if the worker is outdated, restart it to load the current code. The command was not retried.",
          }),
        );

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
          if (done) return Effect.fail(lostResponse());

          if (frame.type === "failed")
            return Effect.fail(new WorkerRequestError({ message: frame.message }));

          if (frame.type === "done")
            return Effect.sync(() => {
              done = true;
            });

          if (frame.type === "reasoning-delta" || frame.type === "reasoning-end")
            return writeReasoning?.(frame) ?? Effect.void;

          if (frame.type === "stderr")
            return Effect.gen(function* () {
              if (frame.sessionId !== undefined) yield* onSession(frame.sessionId);
              yield* announce(frame.text);
            });

          return write(frame.text);
        }),
      );

      if (!done) return yield* Effect.fail(lostResponse());

      return true;
    }),
  );
