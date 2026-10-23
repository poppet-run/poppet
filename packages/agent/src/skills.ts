import type { SkillSnapshot } from "@poppet/store";
import { Context, type Effect, Layer } from "effect";

import { contextFiles } from "#src/context-files";
import { AgentError } from "#src/errors";

/** Owner-written procedures; viewing one grants no additional capabilities. */
export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<SkillSnapshot, AgentError>;
  }
>()("poppet/Skills") {}

export const SkillsLive = Layer.effect(Skills, contextFiles("skills", "SKILL.md"));

export const skillStorage = (error: { readonly reason: string; readonly message: string }) =>
  new AgentError({
    reason:
      error.reason === "storage" || error.reason === "corrupt" ? "skill-storage" : "tool-arguments",
    message: error.message,
  });
