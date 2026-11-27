import { Session } from "@poppet/store";
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import {
  DecidedApproval,
  PendingApproval,
  RevokedApprovalRules,
  SavedApprovalRule,
  manageApprovals,
} from "#src/commands/approvals/approvals";
import type { ApprovalCommand } from "#src/commands/approvals/approvals";
import type { CLIContext } from "#src/commands/context";
import { booleanFlag, jsonFlag } from "#src/commands/flags";
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

  if (command.action === "rules-list") {
    return printParsed(json, value, Schema.Array(SavedApprovalRule), (items) =>
      tableOr(
        "No saved approval rules.",
        ["ID", "KIND", "USES", "LAST USED", "RULE"],
        items.map((item) => [
          item.id,
          item.kind,
          String(item.useCount),
          item.lastUsedAt === null ? "never" : time(item.lastUsedAt),
          item.summary,
        ]),
      ),
    );
  }

  if (command.action === "rules-revoke") {
    return printParsed(json, value, RevokedApprovalRules, ({ revoked }) =>
      revoked.length === 0
        ? "No saved approval rules to revoke."
        : revoked.length === 1 && revoked[0] !== undefined
          ? `Revoked approval rule ${revoked[0].id} (${revoked[0].kind}).`
          : `Revoked ${revoked.length} approval rules.`,
    );
  }

  return printParsed(json, value, DecidedApproval, (item) =>
    item.state === "approved"
      ? item.ruleId !== undefined
        ? `Approved ${item.id} (${item.kind}) and saved rule ${item.ruleId}.`
        : `Approved ${item.id} (${item.kind}).`
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
  const optionalIdArgument = idArgument.pipe(Argument.optional);

  const alwaysFlag = booleanFlag("always", "Save a reusable approval rule when safe");
  const allFlag = booleanFlag("all", "Revoke all saved approval rules");

  const rulesCommand = Command.make("rules", { json: jsonFlag }, ({ json }) =>
    runApproval({ action: "rules-list" }, json),
  ).pipe(
    Command.withDescription("List and revoke saved approval rules"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        runApproval({ action: "rules-list" }, json),
      ).pipe(Command.withDescription("List saved approval rules")),
      Command.make(
        "revoke",
        { id: optionalIdArgument, all: allFlag, json: jsonFlag },
        ({ id, all, json }) =>
          runApproval(
            {
              action: "rules-revoke",
              ...(Option.isSome(id) && { id: id.value }),
              ...(all && { all: true }),
            },
            json,
          ),
      ).pipe(Command.withDescription("Revoke one or all saved approval rules")),
    ]),
  );

  return Command.make("approvals", { json: jsonFlag }, ({ json }) =>
    runApproval({ action: "list" }, json),
  ).pipe(
    Command.withDescription("List and answer pending owner approvals"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        runApproval({ action: "list" }, json),
      ).pipe(Command.withDescription("List pending approvals")),
      Command.make(
        "approve",
        { id: idArgument, always: alwaysFlag, json: jsonFlag },
        ({ id, always, json }) =>
          runApproval({ action: "approve", id, ...(always && { always: true }) }, json),
      ).pipe(Command.withDescription("Approve a pending action once, or save a reusable rule")),
      Command.make("deny", { id: idArgument, json: jsonFlag }, ({ id, json }) =>
        runApproval({ action: "deny", id }, json),
      ).pipe(Command.withDescription("Deny a pending action")),
      rulesCommand,
    ]),
  );
};
