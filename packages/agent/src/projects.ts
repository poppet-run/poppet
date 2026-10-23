import { AppConfig } from "@poppet/config";
import { ProjectNotes, ProjectSnapshot } from "@poppet/store";
import { Context, Effect, Layer, Option, Schema } from "effect";

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

/** Loading a named project requires the Projects service; missing context fails the request. */
export const loadProject = (name: string) =>
  Effect.gen(function* () {
    const projects = yield* Effect.serviceOption(Projects);

    if (Option.isNone(projects))
      return yield* Effect.fail(
        new AgentError({
          reason: "invalid-request",
          message: "Project context is unavailable. Restart the worker with the current code.",
        }),
      );

    return yield* projects.value.load(name);
  });
