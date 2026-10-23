import { Skills } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { LearnedSkills, SkillError, promoteSkill } from "@poppet/skills";
import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

/** Owner skill-library requests shared by direct CLI execution and worker routing. */
export const SkillsCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literals(["show", "history", "delete", "promote"]),
    name: SkillName,
  }),
  Schema.Struct({
    action: Schema.Literal("revert"),
    name: SkillName,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
]);

export type SkillsCommand = typeof SkillsCommand.Type;

const notFound = (name: string) =>
  new SkillError({
    reason: "not-found",
    message: `No owner or learned skill is named ${JSON.stringify(name)}.`,
  });

export const manageSkills = (command: SkillsCommand) =>
  Effect.gen(function* () {
    const skills = yield* Skills;
    const learned = yield* LearnedSkills;
    const owned = yield* skills.list;

    if (command.action === "list") {
      const saved = yield* learned.list;

      const entries = [
        ...owned.map((name) => ({ name, source: "owner" as const })),
        ...saved.map(({ name, revision, updatedAt }) => ({
          name,
          source: "learned" as const,
          revision,
          updatedAt,
          shadowed: owned.includes(name),
        })),
      ].toSorted((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));

      return JSON.stringify(entries, null, 2);
    }

    const name = command.name;

    if (command.action === "show") {
      // An owner directory always wins, even when its file is invalid.
      if (owned.includes(name)) return (yield* skills.load(name)).content;
      const skill = yield* learned.get(name);

      if (skill === null) return yield* Effect.fail(notFound(name));

      return skill.content;
    }

    if (command.action === "history") {
      const history = yield* learned.history(name);

      if (history.length === 0) return yield* Effect.fail(notFound(name));

      return JSON.stringify(history, null, 2);
    }

    if (command.action === "revert")
      return JSON.stringify(yield* learned.revert(name, command.revision), null, 2);

    if (command.action === "delete")
      return JSON.stringify(
        yield* learned.write({ action: "delete", name }, { origin: "owner" }),
        null,
        2,
      );

    const skill = yield* learned.get(name);

    if (skill === null) return yield* Effect.fail(notFound(name));
    const { dataDirectory } = yield* AppConfig;
    yield* promoteSkill(dataDirectory, name, skill.content);
    // Validate the published file through the same loader that chats use.
    yield* skills.load(name);

    return `Promoted ${name} revision ${skill.revision} to skills/${name}/SKILL.md. The owner file now takes precedence.`;
  });
