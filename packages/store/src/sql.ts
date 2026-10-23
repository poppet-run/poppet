import { Effect, Schema } from "effect";

/** Decodes every row a query returns. */
export const decodeRows =
  <S extends Schema.Top>(schema: S) =>
  <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    Effect.flatMap(query, (rows) => Schema.decodeUnknownEffect(Schema.Array(schema))(rows));

/** Decodes the first row a query returns, or null when it returns none. */
export const decodeRow =
  <S extends Schema.Top>(schema: S) =>
  <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    Effect.flatMap(query, ([first]) =>
      first === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(schema)(first),
    );
