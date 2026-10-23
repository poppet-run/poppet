import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { SkillError } from "#src/errors";

const promotionFailure = (cause: unknown) =>
  cause instanceof SkillError
    ? cause
    : new SkillError({
        reason: cause instanceof Schema.SchemaError ? "invalid-request" : "storage",
        message:
          cause instanceof Schema.SchemaError
            ? "Use a skill name containing only letters, digits, underscores, or hyphens."
            : "Could not create the owner skill file. Check that <data directory>/skills is a regular directory without symlinks.",
      });

/** Creates skills/<name>/SKILL.md without replacing or following anything already there. */
export const promoteSkill = (dataDirectory: string, name: string, content: string) =>
  Effect.tryPromise({
    try: async () => {
      Schema.decodeUnknownSync(SkillName)(name);
      const root = join(await realpath(dataDirectory), "skills");

      await mkdir(root, { mode: 0o700 }).catch((cause: unknown) => {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      });

      const info = await lstat(root);

      if (!info.isDirectory() || info.isSymbolicLink()) throw promotionFailure(null);

      await mkdir(join(root, name), { mode: 0o700 }).catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
          throw new SkillError({
            reason: "conflict",
            message: `An owner skill directory named ${JSON.stringify(name)} already exists.`,
          });
        throw cause;
      });

      const handle = await open(
        join(root, name, "SKILL.md"),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );

      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    },
    catch: promotionFailure,
  });
