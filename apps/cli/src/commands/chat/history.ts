import { AgentError } from "@poppet/agent";
import { AttachmentReference, Output, outputText } from "@poppet/provider";
import { Session } from "@poppet/store";
import { Effect, Schema } from "effect";

export const HistoryMessages = Schema.Array(
  Schema.Struct({
    message: Schema.Union([
      Schema.Struct({
        role: Schema.Literal("user"),
        text: Schema.String,
        attachments: Schema.optionalKey(Schema.Array(AttachmentReference)),
        skills: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      }),
      Schema.Struct({ role: Schema.Literal("assistant"), output: Schema.Array(Output) }),
      Schema.Struct({ role: Schema.Literal("tool") }),
    ]),
  }),
);

const Inspection = Schema.Struct({
  session: Schema.Struct({ id: Session.fields.id }),
  messages: HistoryMessages,
});

export interface ChatHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export const chatHistory = (messages: typeof HistoryMessages.Type) => {
  const history: ChatHistoryMessage[] = [];

  for (const { message } of messages) {
    if (message.role === "tool") continue;

    if (message.role === "user") {
      const attachments = message.attachments?.map(({ name }) => name) ?? [];
      const skills = message.skills?.map(({ name }) => name) ?? [];
      history.push({
        role: "user",
        text:
          message.text +
          (attachments.length ? `\n[Attached: ${attachments.join(", ")}]` : "") +
          (skills.length ? `\n[Skills: ${skills.join(", ")}]` : ""),
      });
      continue;
    }

    const text = outputText(message.output);

    if (text) history.push({ role: "assistant", text });
  }

  return history;
};

export const readChatHistory = <A>(value: A, sessionId: string) =>
  Effect.gen(function* () {
    const inspection = yield* Schema.decodeUnknownEffect(Inspection)(value).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "invalid-request",
            message: "Could not read the saved chat history.",
          }),
      ),
    );

    if (inspection.session.id !== sessionId)
      return yield* Effect.fail(
        new AgentError({
          reason: "invalid-request",
          message: "The history returned a different session.",
        }),
      );

    return chatHistory(inspection.messages);
  });
