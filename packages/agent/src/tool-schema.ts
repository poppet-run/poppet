import { decodeToolArguments, type Tool } from "@poppet/provider";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";

/** Strict tool arguments with the agent's user-facing error. */
export const toolArguments =
  <S extends Schema.Constraint>(tool: Tool, schema: S) =>
  (json: string) =>
    decodeToolArguments(schema)(json).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "tool-arguments",
            message: `Invalid arguments for ${tool.namespace}.${tool.name}.`,
          }),
      ),
    );

/** Nonempty, trimmed text bounded by its UTF-8 byte length. */
export const BoundedText = (bytes: number) =>
  Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.makeFilter((value) => Buffer.byteLength(value) <= bytes),
  );
