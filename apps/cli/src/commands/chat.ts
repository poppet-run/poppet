import { ChatSettings, logChatDiagnostic } from "@poppet/agent";
import { Session, SessionSearchQuery } from "@poppet/store";
import { Console, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import {
  inspectChat,
  type ChatCommand,
  MessageText,
  prepareChat,
  sendChat,
  type ChatWriter,
} from "#src/chat";
import { interactiveChat, interactiveChatOutput } from "#src/chat-prompt";
import type { CLIContext } from "#src/commands/context";
import { attachFlag, codingFlag, skillFlag, textArgument } from "#src/commands/flags";

export const chatCommand = (context: CLIContext) => {
  const { runtime, throughWorker, write, writeThinking, readLine } = context;

  const runChat = (
    command: ChatCommand,
    onSession: ChatWriter = () => Effect.void,
    interactive = false,
  ) => {
    if (
      command.action === "show" ||
      command.action === "sessions" ||
      command.action === "rename" ||
      command.action === "search"
    ) {
      const inspection =
        command.action === "search"
          ? ChatSettings.pipe(
              Effect.flatMap(({ toolBytes }) => inspectChat(command, toolBytes)),
              Effect.provide(runtime.chatSettings),
            )
          : inspectChat(command);

      return throughWorker(
        { kind: "chat", command },
        inspection.pipe(Effect.provide(runtime.store), Effect.flatMap(Console.log)),
      );
    }

    return Effect.scoped(
      Effect.gen(function* () {
        const output =
          interactive || command.action === "new"
            ? yield* interactiveChatOutput(write, writeThinking)
            : undefined;

        const submission = yield* prepareChat(command);

        yield* throughWorker(
          { kind: "chat", command: submission },
          sendChat(
            submission,
            output?.answer ?? write,
            (text, sessionId) =>
              Effect.gen(function* () {
                if (sessionId !== undefined) yield* onSession(sessionId);
                yield* output?.announce(text) ?? logChatDiagnostic(text);
              }),
            output === undefined ? {} : { write: output.reasoning, log: () => Effect.void },
            output === undefined
              ? Console.error
              : (line) => output.announce(line).pipe(Effect.ignore),
          ).pipe(Effect.provide(runtime.chat)),
          onSession,
          output,
        );
      }).pipe(Effect.provide(runtime.config)),
    );
  };

  return Command.make("chat").pipe(
    Command.withDescription("Chat with the configured provider and model"),
    Command.withSubcommands([
      Command.make(
        "interactive",
        {
          id: Argument.String("session").pipe(
            Argument.withSchema(Session.fields.id),
            Argument.optional,
          ),
          coding: codingFlag,
          skill: skillFlag,
        },
        ({ id, coding, skill }) =>
          interactiveChat(
            { sessionId: Option.getOrUndefined(id), coding, skill },
            (command, onSession) => runChat(command, onSession, true),
            readLine,
          ),
      ).pipe(Command.withDescription("Open a terminal prompt for a new or saved session")),
      Command.make(
        "new",
        {
          coding: codingFlag,
          skill: skillFlag,
          attach: attachFlag,
          text: textArgument("message").pipe(Argument.withSchema(MessageText)),
        },
        ({ coding, text, skill, attach }) => {
          const command: ChatCommand = { action: "new", coding, text, attachments: attach };

          const selected = skill === undefined ? command : { ...command, skill };

          return runChat(selected);
        },
      ).pipe(Command.withDescription("Start a session")),
      Command.make(
        "send",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
          attach: attachFlag,
          text: textArgument("message").pipe(Argument.withSchema(MessageText)),
        },
        ({ id, text, attach }) => runChat({ action: "send", id, text, attachments: attach }),
      ).pipe(Command.withDescription("Continue a saved session")),
      Command.make(
        "rename",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
          text: textArgument("title").pipe(Argument.withSchema(MessageText)),
        },
        ({ id, text }) => runChat({ action: "rename", id, text }),
      ).pipe(Command.withDescription("Rename a saved session")),
      Command.make("sessions", {}, () => runChat({ action: "sessions" })).pipe(
        Command.withDescription("List sessions"),
      ),
      Command.make(
        "search",
        { query: textArgument("query").pipe(Argument.withSchema(SessionSearchQuery)) },
        ({ query }) => runChat({ action: "search", query }),
      ).pipe(Command.withDescription("Search completed conversations")),
      Command.make(
        "show",
        {
          id: Argument.String("session").pipe(Argument.withSchema(Session.fields.id)),
        },
        ({ id }) => runChat({ action: "show", id }),
      ).pipe(Command.withDescription("Show messages and run outcomes")),
    ]),
  );
};
