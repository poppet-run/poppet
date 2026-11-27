import { Session } from "@poppet/store";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import {
  DecidedApproval,
  PendingApproval,
  manageApprovals,
} from "#src/commands/approvals/approvals";
import type { ApprovalCommand } from "#src/commands/approvals/approvals";
import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { printParsed, tableOr, time } from "#src/output";

const printApprovalResult = <A>(json: boolean, command: ApprovalCommand, value: A) => {
  if (command.action === "list") {
    return printParsed(json, value, Schema.Array(PendingApproval), (items) =>
      tableOr(
        "No pending approvals.",
        ["ID", "KIND", "CONVERSATION", "EXPIRES", "SUMMARY"],
        items.map((item) => [
          item.id,
          item.kind,
          item.conversation,
          time(item.expiresAt),
          item.summary,
        ]),
      ),
    );
  }

  return printParsed(json, value, DecidedApproval, (item) =>
    item.state === "approved"
      ? `Approved ${item.id} (${item.kind}).`
      : `Denied ${item.id} (${item.kind}).`,
  );
};

export const approvalsCommand = (context: CLIContext) => {
  const { runtime, queryWorker } = context;

  const runApproval = (command: ApprovalCommand, json: boolean) =>
    queryWorker(
      { kind: "approvals", command },
      manageApprovals(command).pipe(Effect.provide(runtime.store)),
    ).pipe(Effect.flatMap((result) => printApprovalResult(json, command, result)));

  const idArgument = Argument.String("id").pipe(Argument.withSchema(Session.fields.id));

  return Command.make("approvals", { json: jsonFlag }, ({ json }) =>
    runApproval({ action: "list" }, json),
  ).pipe(
    Command.withDescription("List and answer pending owner approvals"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        runApproval({ action: "list" }, json),
      ).pipe(Command.withDescription("List pending approvals")),
      Command.make("approve", { id: idArgument, json: jsonFlag }, ({ id, json }) =>
        runApproval({ action: "approve", id }, json),
      ).pipe(Command.withDescription("Approve a pending action once")),
      Command.make("deny", { id: idArgument, json: jsonFlag }, ({ id, json }) =>
        runApproval({ action: "deny", id }, json),
      ).pipe(Command.withDescription("Deny a pending action")),
    ]),
  );
};
