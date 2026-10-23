import { AppConfig } from "@poppet/config";
import { ProjectNotes, ProjectSnapshot } from "@poppet/store";
import { Context, Effect, Layer, Schema } from "effect";

import { contextFiles } from "#src/context-files";
import { AgentError } from "#src/errors";
import { validateProjectNotes } from "#src/notes";

export class Projects extends Context.Service<
  Projects,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<ProjectSnapshot, AgentError>;
  }
>()("poppet/Projects") {}

export const ProjectsLive = Layer.effect(
  Projects,
  Effect.gen(function* () {
    const files = yield* contextFiles("projects", "PROJECT.md");
    const { notesDirectory } = yield* AppConfig;

    return {
      list: files.list,
      load: (name) =>
        Effect.gen(function* () {
          const instructions = yield* files.load(name);
          const json = yield* files.read(name, "notes.json", true);

          const notes =
            json === null
              ? null
              : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectNotes))(json).pipe(
                  Effect.mapError(
                    () =>
                      new AgentError({
                        reason: "invalid-request",
                        message:
                          "Project notes.json must list at most eight distinct relative note paths.",
                      }),
                  ),
                );

          if (notes !== null) yield* validateProjectNotes(notesDirectory, notes);

          return { ...instructions, notes };
        }),
    } satisfies Projects["Service"];
  }),
);

export const loadProject = (name: string) => Projects.use((projects) => projects.load(name));
