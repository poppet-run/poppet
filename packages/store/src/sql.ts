import { Effect, Schema } from "effect";

export const decodeRows =
  <S extends Schema.Top>(schema: S) =>
  <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    Effect.flatMap(query, (rows) => Schema.decodeUnknownEffect(Schema.Array(schema))(rows));

export const decodeRow =
  <S extends Schema.Top>(schema: S) =>
  <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    Effect.flatMap(query, ([first]) =>
      first === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(schema)(first),
    );
