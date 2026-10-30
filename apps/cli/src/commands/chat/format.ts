import { Schema } from "effect";

import type { ChatCommand } from "#src/commands/chat/chat";
import { chatHistory, HistoryMessages } from "#src/commands/chat/history";
import { bold, fields, printParsed, sections, table, tableOr, time } from "#src/output";

const Time = Schema.NullOr(Schema.Number);

/** The session fields that text output shows. */
const SessionRow = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  title: Schema.NullOr(Schema.String),
  skill: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});

type SessionRow = typeof SessionRow.Type;

const SearchResult = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      createdAt: Schema.Number,
      role: Schema.String,
      title: Schema.NullOr(Schema.String),
      excerpt: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});

const SessionDetails = Schema.Struct({
  session: SessionRow,
  messages: HistoryMessages,
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      startedAt: Time,
      finishedAt: Time,
      failureReason: Schema.NullOr(Schema.String),
      usage: Schema.NullOr(
        Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }),
      ),
    }),
  ),
  toolCalls: Schema.Array(Schema.Struct({ runId: Schema.String })),
});

const title = (session: SessionRow) => session.title ?? "Untitled";

const renderSessions = (sessions: ReadonlyArray<SessionRow>) =>
  tableOr(
    "No sessions. Start one with poppet chat new.",
    ["ID", "UPDATED", "MODEL", "TITLE"],
    sessions.map((session) => [
      session.id,
      time(session.updatedAt),
      `${session.provider} ${session.model}`,
      title(session),
    ]),
  );

const renderSearch = (result: typeof SearchResult.Type) => {
  if (result.matches.length === 0) return "No matching messages.";

  const rows = table(
    ["SESSION", "CREATED", "ROLE", "TITLE", "EXCERPT"],
    result.matches.map((match) => [
      match.sessionId,
      time(match.createdAt),
      match.role,
      match.title ?? "Untitled",
      match.excerpt,
    ]),
  );

  return result.truncated ? `${rows}\n\nMore matches were omitted. Refine the query.` : rows;
};

const renderSession = ({ session, messages, runs, toolCalls }: typeof SessionDetails.Type) => {
  const history = chatHistory(messages);

  return sections([
    [
      null,
      fields([
        ["ID", session.id],
        ["Title", title(session)],
        ["Model", `${session.provider} ${session.model}`],
        session.skill === null ? null : ["Skill", session.skill.name],
        ["Created", time(session.createdAt)],
        ["Updated", time(session.updatedAt)],
      ]),
    ],
    [
      "Messages",
      history.length === 0
        ? "None."
        : history
            .map(
              (message) =>
                `${bold(message.role === "user" ? "You" : "Poppet")}\n${message.text.trim()}`,
            )
            .join("\n\n"),
    ],
    [
      "Runs",
      tableOr(
        "None.",
        ["ID", "STATUS", "STARTED", "FINISHED", "TOKENS", "TOOLS", "FAILURE"],
        runs.map((run) => [
          run.id,
          run.status,
          time(run.startedAt),
          time(run.finishedAt),
          run.usage === null ? "-" : `${run.usage.inputTokens} in, ${run.usage.outputTokens} out`,
          String(toolCalls.filter((call) => call.runId === run.id).length),
          run.failureReason ?? "-",
        ]),
      ),
    ],
  ]);
};

/** Prints a session inspection; local results and worker replies share each action's shape. */
export const printChatInspection = <A>(
  json: boolean,
  command: Extract<ChatCommand, { action: "show" | "sessions" | "rename" | "search" }>,
  value: A,
) => {
  switch (command.action) {
    case "sessions":
      return printParsed(json, value, Schema.Array(SessionRow), renderSessions);
    case "search":
      return printParsed(json, value, SearchResult, renderSearch);
    case "rename":
      return printParsed(
        json,
        value,
        SessionRow,
        (session) => `Renamed session ${session.id} to ${title(session)}.`,
      );
    case "show":
      return printParsed(json, value, SessionDetails, renderSession);
  }
};
