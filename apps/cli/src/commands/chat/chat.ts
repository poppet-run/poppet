import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { styleText } from "node:util";

import {
  Agent,
  AgentError,
  defaultPolicy,
  logChatDiagnostic,
  Skills,
  sessionTitle,
  type ChatEvent,
  type SendOptions,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { readFileBounded } from "@poppet/io";
import {
  Session,
  SessionSearchQuery,
  SkillName,
  Store,
  type StoredMessage,
  type Run,
} from "@poppet/store";
import { Effect, Schema, Stream } from "effect";

/** Nonblank user input whose original spacing is preserved. */
export const MessageText = Schema.NonEmptyString.check(
  Schema.makeFilter((text) => text.trim().length > 0 || "Enter a nonempty message."),
);

/** A file read by the command line, carried to the worker as base64. */
const ChatAttachment = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  base64: Schema.String,
});

const ChatAttachments = Schema.optionalKey(
  Schema.Array(ChatAttachment).check(Schema.isMaxLength(defaultPolicy.attachmentsPerMessage)),
);

/** Validated local or worker chat requests; new sessions carry an explicit model selection. */
export const ChatRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("new"),
    text: MessageText,
    provider: Session.fields.provider,
    model: Session.fields.model,
    skill: Schema.optionalKey(SkillName),
    attachments: ChatAttachments,
  }),
  Schema.Struct({
    action: Schema.Literal("send"),
    id: Session.fields.id,
    text: MessageText,
    attachments: ChatAttachments,
  }),
  Schema.Struct({ action: Schema.Literal("rename"), id: Session.fields.id, text: MessageText }),
  Schema.Struct({ action: Schema.Literal("show"), id: Session.fields.id }),
  Schema.Struct({ action: Schema.Literal("sessions") }),
  Schema.Struct({ action: Schema.Literal("search"), query: SessionSearchQuery }),
]);

export type ChatRequest = typeof ChatRequest.Type;

/**
 * Parsed chat actions; a new session still needs its provider and model resolved, and attached
 * files are paths until they are read.
 */
export type ChatCommand =
  | Exclude<ChatRequest, { readonly action: "new" | "send" }>
  | {
      readonly action: "send";
      readonly id: string;
      readonly text: string;
      readonly attachments?: ReadonlyArray<string>;
    }
  | {
      readonly action: "new";
      readonly text: string;
      readonly skill?: string;
      readonly attachments?: ReadonlyArray<string>;
    };

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
      ? { role: "assistant" as const, output: entry.message.output }
      : entry.message,
});

const runForInspection = (run: Run) => ({
  id: run.id,
  sessionId: run.sessionId,
  provider: run.provider,
  model: run.model,
  status: run.status,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  failureReason: run.failureReason,
  output: run.result?.output ?? null,
  usage: run.result?.usage ?? null,
  finishReason: run.result?.finishReason ?? null,
});

/** Saved session data, as plain values for the caller to format. */
export const inspectChat = (
  command: Extract<ChatCommand, { action: "show" | "sessions" | "rename" | "search" }>,
  toolBytes = defaultPolicy.toolBytes,
) =>
  Effect.gen(function* () {
    const store = yield* Store;

    if (command.action === "search") return yield* store.searchSessions(command.query, toolBytes);

    if (command.action === "rename")
      return yield* store.renameSession(command.id, sessionTitle(command.text));

    if (command.action === "sessions") return yield* store.sessions;

    return yield* showSession(command.id);
  });

const showSession = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const session = yield* store.session(id);

    if (session === null)
      return yield* Effect.fail(
        new AgentError({ reason: "invalid-request", message: "The session does not exist." }),
      );
    const messages = yield* store.messages(session.id);
    const runs = yield* store.runs(session.id);
    const toolCalls = (yield* Effect.forEach(runs, (run) => store.toolCalls(run.id))).flat();

    return {
      session,
      toolCalls,
      messages: messages.map(messageForInspection),
      runs: runs.map(runForInspection),
    };
  });

const attachmentLimit = Math.max(defaultPolicy.imageBytes, defaultPolicy.textFileBytes);

/** Reads one attached file within the largest size the agent accepts, without blocking on a FIFO. */
const readAttachment = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const name = basename(path);
      await using handle = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);

      if (!(await handle.stat()).isFile())
        throw new AgentError({
          reason: "attachment",
          message: `Cannot attach ${JSON.stringify(name)}: it is not a regular file.`,
        });

      const body = await readFileBounded(
        handle,
        attachmentLimit,
        () =>
          new AgentError({
            reason: "attachment",
            message: `Cannot attach ${JSON.stringify(name)}: the file is larger than ${attachmentLimit / 1024 / 1024} MiB.`,
          }),
      );

      return { name, base64: body.toString("base64") };
    },
    catch: (cause) =>
      cause instanceof AgentError
        ? cause
        : new AgentError({
            reason: "attachment",
            message: `Cannot read ${JSON.stringify(path)}. Check the path and its permissions.`,
          }),
  });

export const prepareChat = (
  command: Extract<ChatCommand, { action: "new" | "send" }>,
): Effect.Effect<ChatSubmission, AgentError, AppConfig> =>
  Effect.gen(function* () {
    if ((command.attachments?.length ?? 0) > defaultPolicy.attachmentsPerMessage)
      return yield* Effect.fail(
        new AgentError({
          reason: "attachment",
          message: `Attach at most ${defaultPolicy.attachmentsPerMessage} files to one message.`,
        }),
      );

    const read = command.attachments ?? [];
    const attachments = yield* Effect.forEach(read, readAttachment);
    const attached = attachments.length === 0 ? {} : { attachments };

    if (command.action === "send")
      return { action: "send", id: command.id, text: command.text, ...attached };
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
      ...attached,
    };

    return command.skill === undefined ? request : { ...request, skill: command.skill };
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

    const options: SendOptions = {
      attachments: (command.attachments ?? []).map(({ name, base64 }) => ({
        name,
        body: Buffer.from(base64, "base64"),
      })),
    };

    const reply = agent.send(sessionId, command.text, {
      ...options,
      ...(reasoning.log !== undefined && { reasoningLog: reasoning.log }),
      ...(timingLog !== undefined && { timingLog }),
    });

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
