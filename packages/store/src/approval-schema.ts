import { Schema } from "effect";

import { CommandProposal } from "#src/command-schema";
import { DeliveryDestination, Id, ProjectNotes } from "#src/schema";

export const ProposalPath = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (path) =>
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.isWellFormed() &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) &&
      !path.startsWith("/") &&
      !path.split("/").some((part) => !part || part === "." || part === "..") &&
      /\.(md|markdown|txt)$/i.test(path),
  ),
);

export const ProposalContent = Schema.String.check(
  Schema.makeFilter(
    (text) => Buffer.byteLength(text) <= 65536 && !text.includes("\0") && text.isWellFormed(),
  ),
);

export const NoteTarget = Schema.Struct({
  root: Schema.NonEmptyString,
  device: Schema.Natural,
  inode: Schema.Natural,
});

export type NoteTarget = typeof NoteTarget.Type;

export const NoteProposal = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("create_note"),
  path: ProposalPath,
  content: ProposalContent,
  target: NoteTarget,
  selected: Schema.NullOr(ProjectNotes),
});

export type NoteProposal = typeof NoteProposal.Type;

export const ActionProposal = Schema.Union([NoteProposal, CommandProposal]);

export type ActionProposal = typeof ActionProposal.Type;

export const ApprovalState = Schema.Literals([
  "pending",
  "executing",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "uncertain",
]);

export type ApprovalState = typeof ApprovalState.Type;

export const Approval = Schema.Struct({
  id: Id,
  owner: Schema.NonEmptyString,
  payload: Schema.fromJsonString(ActionProposal),
  digest: Schema.NonEmptyString,
  sessionId: Id,
  runId: Id,
  callId: Schema.NonEmptyString,
  jobId: Schema.NullOr(Id),
  revision: Schema.NullOr(Schema.Natural),
  occurrenceId: Schema.NullOr(Id),
  destination: Schema.NullOr(Schema.fromJsonString(DeliveryDestination)),
  createdAt: Schema.Natural,
  expiresAt: Schema.Natural,
  state: ApprovalState,
  receipt: Schema.NullOr(Schema.fromJsonString(Schema.JsonObject)),
});

export type Approval = typeof Approval.Type;
