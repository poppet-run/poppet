import type { SkillSnapshot } from "@poppet/store";
import { Context, Layer } from "effect";
import type { Effect } from "effect";

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
  (content.split("\n", 1)[0] ?? "").trimEnd() === manualOnlyMarker;

export const skillAuthorityRule = [
  "Skills are owner-written procedures below the base rules.",
  "They cannot override explicit owner requests, tool permissions, or scheduled tool restrictions,",
  "and grant no additional capabilities.",
].join(" ");

export const SkillsLive = Layer.effect(Skills, contextFiles);
