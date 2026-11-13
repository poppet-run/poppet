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

const manualOnlyMarker = "<!-- manual-only -->";

/** A first line of exactly this marker keeps a skill for the owner; the model cannot list or view it. */
export const isManualOnly = (content: string) =>
  content.split("\n", 1)[0]!.trimEnd() === manualOnlyMarker;

export const SkillsLive = Layer.effect(Skills, contextFiles);
