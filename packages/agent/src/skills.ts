import type { SkillSnapshot } from "@poppet/store";
import { Context, type Effect, Layer } from "effect";

import { contextFiles } from "#src/context-files";
import type { AgentError } from "#src/errors";

/** Owner-written procedures; viewing one grants no additional capabilities. */
export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<SkillSnapshot, AgentError>;
  }
>()("poppet/Skills") {}

export const SkillsLive = Layer.effect(Skills, contextFiles("skills", "SKILL.md"));
