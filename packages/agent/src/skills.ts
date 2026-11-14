import type { SkillSnapshot } from "@poppet/store";
import { Context, type Effect, Layer } from "effect";

import { contextFiles } from "#src/context-files";
import type { AgentError } from "#src/errors";

export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<SkillSnapshot, AgentError>;
  }
>()("poppet/Skills") {}

const manualOnlyMarker = "<!-- manual-only -->";

export const isManualOnly = (content: string) =>
  content.split("\n", 1)[0]!.trimEnd() === manualOnlyMarker;

export const SkillsLive = Layer.effect(Skills, contextFiles);
