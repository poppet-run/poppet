import { decodeToolArguments, type Tool } from "@poppet/provider";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";

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

export const BoundedText = (bytes: number) =>
  Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.makeFilter((value) => Buffer.byteLength(value) <= bytes),
  );
