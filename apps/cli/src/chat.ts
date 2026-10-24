import { styleText } from "node:util";

import {
  Agent,
  AgentError,
  defaultPolicy,
  logChatDiagnostic,
  Skills,
  sessionTitle,
  type ChatEvent,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import {
  Session,
  SessionSearchQuery,
  SkillName,
  Store,
  type StoredMessage,
  type Run,
} from "@poppet/store";
import { Effect, Schema, Stream } from "effect";

/** Parsed chat actions before defaults are resolved into an executable request. */
export type ChatCommand =
  | {
      readonly action: "new";
      readonly text: string;
      readonly coding: boolean;
      readonly skill?: string;
    }
  | { readonly action: "send"; readonly id: string; readonly text: string }
  | { readonly action: "rename"; readonly id: string; readonly text: string }
  | { readonly action: "sessions" }
  | { readonly action: "search"; readonly query: string }
  | { readonly action: "show"; readonly id: string };

/** Nonblank user input whose original spacing is preserved. */
export const MessageText = Schema.NonEmptyString.check(
  Schema.makeFilter((text) => text.trim().length > 0 || "Enter a nonempty message."),
);

/** Validated local or worker chat requests; new sessions carry an explicit model selection. */
export const ChatRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("new"),
    text: MessageText,
    provider: Session.fields.provider,
    model: Session.fields.model,
    workload: Session.fields.workload,
    skill: Schema.optionalKey(SkillName),
  }),
  Schema.Struct({ action: Schema.Literal("send"), id: Session.fields.id, text: MessageText }),
  Schema.Struct({ action: Schema.Literal("rename"), id: Session.fields.id, text: MessageText }),
  Schema.Struct({ action: Schema.Literal("show"), id: Session.fields.id }),
  Schema.Struct({ action: Schema.Literal("sessions") }),
  Schema.Struct({ action: Schema.Literal("search"), query: SessionSearchQuery }),
]);

export type ChatRequest = typeof ChatRequest.Type;

type ChatSubmission = Extract<ChatRequest, { action: "new" | "send" }>;

/** A streamed text sink that can report write failures to the active request. */
export type ChatWriter = (text: string) => Effect.Effect<void, AgentError>;

/** Session metadata accompanies its announcement without parsing terminal output. */
export type ChatAnnouncer = (text: string, sessionId?: string) => Effect.Effect<void, AgentError>;

/** Routes live reasoning separately from buffered diagnostic log entries. */
export type ChatReasoningWriter = (
  event: Extract<ChatEvent, { type: "reasoning-delta" | "reasoning-end" }>,
) => Effect.Effect<void, AgentError>;

export interface ChatReasoning {
  readonly write?: ChatReasoningWriter;
  readonly log?: (line: string) => Effect.Effect<void>;
}

const writeChatOutput = (output: NodeJS.WriteStream, text: string) =>
  Effect.callback<void, AgentError>((resume) => {
    output.write(text, (error) =>
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

export const writeChatText: ChatWriter = (text) => writeChatOutput(process.stdout, text);

export const writeChatThinking: ChatWriter = (text) =>
  writeChatOutput(
    process.stderr,
    process.env.NO_COLOR ? text : styleText(["dim", "cyan"], text, { stream: process.stderr }),
  );

const messageForInspection = (entry: StoredMessage) => ({
  id: entry.id,
  sessionId: entry.sessionId,
  runId: entry.runId,
  position: entry.position,
  createdAt: entry.createdAt,
  message:
    entry.message.role === "assistant"
      ? { role: "assistant", output: entry.message.output }
      : entry.message,
});

const runForInspection = (run: Run) => ({
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
});

export const inspectChat = (
  command: Extract<ChatCommand, { action: "show" | "sessions" | "rename" | "search" }>,
  toolBytes = defaultPolicy.toolBytes,
) =>
  Effect.gen(function* () {
    const store = yield* Store;

    if (command.action === "search")
      return JSON.stringify(yield* store.searchSessions(command.query, toolBytes));

    if (command.action === "rename")
      return JSON.stringify(
        yield* store.renameSession(command.id, sessionTitle(command.text)),
        null,
        2,
      );

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
        messages: messages.map(messageForInspection),
        runs: runs.map(runForInspection),
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
          message: "Set model in config.json before starting a session.",
        }),
      );

    const request: ChatSubmission = {
      action: "new",
      text: command.text,
      provider: config.provider,
      model,
      workload: command.coding ? "coding" : "assistant",
    };

    const selected = command.skill === undefined ? request : { ...request, skill: command.skill };

    return selected;
  });

const resolveChatSession = (command: ChatSubmission) =>
  Effect.gen(function* () {
    const store = yield* Store;

    const selectedSkill = command.action === "new" ? command.skill : undefined;

    const skill =
      selectedSkill !== undefined
        ? yield* Skills.use((skills) => skills.load(selectedSkill))
        : null;

    return command.action === "new"
      ? (yield* store.createSession(command.provider, command.model, {
          workload: command.workload,
          skill,
        })).id
      : command.id;
  });

export const sendChat = (
  command: ChatSubmission,
  write: ChatWriter,
  announce: ChatAnnouncer = logChatDiagnostic,
  reasoning: ChatReasoning = {},
  timingLog?: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const sessionId = yield* resolveChatSession(command);
    yield* announce(`Session: ${sessionId}`, sessionId);
    const agent = yield* Agent;

    const options = reasoning.log === undefined ? {} : { reasoningLog: reasoning.log };

    const reply = agent.send(
      sessionId,
      command.text,
      timingLog === undefined ? options : { ...options, timingLog },
    );

    yield* Stream.runForEach(reply, (event) => {
      if (event.type === "started") return announce(`Run: ${event.run.id}`);

      if (event.type === "text-delta") return write(event.text);

      if (event.type === "reasoning-delta" || event.type === "reasoning-end")
        return reasoning.write?.(event) ?? Effect.void;

      return Effect.void;
    });
    yield* write("\n");
    yield* agent.nameSession(sessionId, timingLog);
  });
