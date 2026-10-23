import { SkillName, SkillSnapshot } from "@poppet/store";
import { Schema } from "effect";

/** Learned skill Markdown: nonempty, at most 8192 UTF-8 bytes, and free of NUL bytes. */
export const LearnedSkillContent = SkillSnapshot.fields.content.check(
  Schema.makeFilter((text) => text.trim().length > 0 || "Use nonempty skill content."),
);

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const RunId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

/** The current text of a skill Poppet wrote; owner files with the same name take precedence. */
export const LearnedSkill = Schema.Struct({
  name: SkillName,
  revision: Revision,
  content: LearnedSkillContent,
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
});

export type LearnedSkill = typeof LearnedSkill.Type;

export const SkillOrigin = Schema.Literals(["owner", "turn", "review"]);

export type SkillOrigin = typeof SkillOrigin.Type;

/** One append-only history entry; a deletion keeps its tombstone so it can be reverted. */
export const SkillRevision = Schema.Struct({
  name: SkillName,
  revision: Revision,
  action: Schema.Literals(["create", "patch", "replace", "delete", "revert"]),
  content: Schema.NullOr(LearnedSkillContent),
  origin: SkillOrigin,
  sourceRunId: Schema.NullOr(RunId),
  sourceCallId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});

export type SkillRevision = typeof SkillRevision.Type;

/** A change requested by the owner or the model; non-create changes may require a revision. */
export type SkillChange =
  | { readonly action: "create"; readonly name: string; readonly content: string }
  | {
      readonly action: "replace";
      readonly name: string;
      readonly content: string;
      readonly expectedRevision?: number;
    }
  | {
      readonly action: "patch";
      readonly name: string;
      readonly old: string;
      readonly new: string;
      readonly expectedRevision?: number;
    }
  | { readonly action: "delete"; readonly name: string; readonly expectedRevision?: number };

/** Host-supplied provenance; model arguments never choose an origin or source. */
export type SkillSource =
  | { readonly origin: "owner" }
  | { readonly origin: "turn" | "review"; readonly runId: string; readonly callId: string };

export interface SkillReceipt {
  readonly name: string;
  readonly revision: number;
  readonly action: SkillRevision["action"];
  readonly deleted: boolean;
}
