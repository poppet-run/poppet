import { Agent, AgentError } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Session, Store } from "@poppet/store";
import { Console, Effect, Schema, Stream } from "effect";

export type ChatCommand =
  | { readonly action: "new"; readonly text: string; readonly coding: boolean }
  | { readonly action: "send"; readonly id: string; readonly text: string }
  | { readonly action: "sessions" }
  | { readonly action: "show"; readonly id: string };

const MessageText = Schema.NonEmptyString.check(
  Schema.makeFilter((text) => text.trim().length > 0 || "Enter a nonempty message."),
);

export const ChatRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("new"),
    text: MessageText,
    provider: Session.fields.provider,
    model: Session.fields.model,
    workload: Session.fields.workload,
  }),
  Schema.Struct({ action: Schema.Literal("send"), id: Session.fields.id, text: MessageText }),
  Schema.Struct({ action: Schema.Literal("show"), id: Session.fields.id }),
  Schema.Struct({ action: Schema.Literal("sessions") }),
]);

export type ChatRequest = typeof ChatRequest.Type;

type ChatSubmission = Extract<ChatRequest, { action: "new" | "send" }>;

export const parseChatCommand = (args: ReadonlyArray<string>): ChatCommand | null => {
  if (args[0] === "sessions" && args.length === 1) return { action: "sessions" };

  if (args[0] === "show" && args.length === 2 && Schema.is(Session.fields.id)(args[1]))
    return { action: "show", id: args[1] };

  if (args[0] === "send" && Schema.is(Session.fields.id)(args[1])) {
    const text = args.slice(2).join(" ");

    return text.trim() ? { action: "send", id: args[1], text } : null;
  }

  if (args[0] === "new") {
    const coding = args[1] === "--coding";
    const text = args.slice(coding ? 2 : 1).join(" ");

    return text.trim() ? { action: "new", coding, text } : null;
  }

  return null;
};

export type ChatWriter = (text: string) => Effect.Effect<void, AgentError>;

export const writeChatText: ChatWriter = (text) =>
  Effect.callback<void, AgentError>((resume) => {
    process.stdout.write(text, (error) =>
      resume(
        error
          ? Effect.fail(
              new AgentError({
                reason: "interrupted",
                message: "Could not write the streamed response.",
              }),
            )
          : Effect.void,
      ),
    );
  });

export const inspectChat = (command: Extract<ChatCommand, { action: "show" | "sessions" }>) =>
  Effect.gen(function* () {
    const store = yield* Store;

    if (command.action === "sessions") return JSON.stringify(yield* store.sessions, null, 2);
    const session = yield* store.session(command.id);

    if (session === null)
      return yield* Effect.fail(
        new AgentError({ reason: "invalid-request", message: "The session does not exist." }),
      );
    const messages = yield* store.messages(session.id);
    const runs = yield* store.runs(session.id);
    const toolCalls = (yield* Effect.forEach(runs, (run) => store.toolCalls(run.id))).flat();

    return JSON.stringify(
      {
        session,
        toolCalls,
        messages: messages.map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          runId: entry.runId,
          position: entry.position,
          createdAt: entry.createdAt,
          message:
            entry.message.role === "assistant"
              ? { role: "assistant", output: entry.message.output }
              : entry.message,
        })),
        runs: runs.map((run) => ({
          id: run.id,
          sessionId: run.sessionId,
          provider: run.provider,
          model: run.model,
          workload: run.workload,
          status: run.status,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          failureReason: run.failureReason,
          output: run.result?.output ?? null,
          usage: run.result?.usage ?? null,
          finishReason: run.result?.finishReason ?? null,
        })),
      },
      null,
      2,
    );
  });

export const prepareChat = (
  command: Extract<ChatCommand, { action: "new" | "send" }>,
): Effect.Effect<ChatSubmission, AgentError, AppConfig> =>
  Effect.gen(function* () {
    if (command.action === "send") return command;
    const config = yield* AppConfig;
    const model = config.model;

    if (model === null)
      return yield* Effect.fail(
        new AgentError({
          reason: "invalid-request",
          message: "Set POPPET_MODEL before starting a session.",
        }),
      );

    return {
      action: "new",
      text: command.text,
      provider: config.provider,
      model,
      workload: command.coding ? "coding" : "assistant",
    };
  });

export const sendChat = (
  command: ChatSubmission,
  write: ChatWriter,
  announce: ChatWriter = (text) => Console.error(text),
) =>
  Effect.gen(function* () {
    const store = yield* Store;

    const sessionId =
      command.action === "new"
        ? (yield* store.createSession(command.provider, command.model, command.workload)).id
        : command.id;

    yield* announce(`Session: ${sessionId}`);
    const agent = yield* Agent;
    yield* Stream.runForEach(agent.send(sessionId, command.text), (event) => {
      if (event.type === "started") return announce(`Run: ${event.run.id}`);

      if (event.type === "text-delta") return write(event.text);

      return Effect.void;
    });
    yield* write("\n");
  });
