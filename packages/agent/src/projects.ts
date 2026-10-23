import type { ProjectSnapshot } from "@poppet/store";
import { Context, type Effect, Layer } from "effect";

import { contextFiles } from "#src/context-files";
import { AgentError } from "#src/errors";

export class Projects extends Context.Service<
  Projects,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<ProjectSnapshot, AgentError>;
  }
>()("poppet/Projects") {}

export const ProjectsLive = Layer.effect(Projects, contextFiles("projects", "PROJECT.md"));

export const loadProject = (name: string) => Projects.use((projects) => projects.load(name));
