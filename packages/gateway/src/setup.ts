import { parseArgs } from "node:util";

import { Effect } from "effect";
import { Prompt } from "effect/cli";

import { GatewayError } from "#src/adapter";

export const parseSetupFlags = (
  args: ReadonlyArray<string>,
  adapter: string,
  help: string,
  names: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
) =>
  Effect.try({
    try: () => {
      if (args[0] !== "setup") {
        throw new Error("Expected setup");
      }

      const allowed = [...names, ...optional];

      const options = Object.fromEntries(
        allowed.map((name) => [name, { type: "string" as const }]),
      );

      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options,
        strict: true,
        allowPositionals: false,
        tokens: true,
      });

      const supplied = tokens.filter((token) => token.kind === "option").map((token) => token.name);
      const unique = new Set(supplied);

      if (unique.size !== supplied.length || names.some((name) => !unique.has(name))) {
        throw new Error("Expected each required setup flag once without duplicates");
      }

      return values;
    },
    catch: () =>
      new GatewayError({ reason: "configuration", message: `Use gateway ${adapter} ${help}.` }),
  });

/**
 * Offers IDs that a live check found, with a way to type one instead. With
 * nothing found, it goes straight to the typed prompt.
 */
export const pickSetupId = <E, R>(
  message: string,
  found: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  saved: string | undefined,
  typed: Effect.Effect<string, E, R>,
) =>
  Effect.gen(function* () {
    if (found.length === 0) {
      return yield* typed;
    }

    const choice = yield* Prompt.Select<string | null>({
      message,
      choices: [
        ...found.map(({ id, name }) => ({
          title: `${name} (${id})`,
          value: id,
          selected: id === saved,
        })),
        { title: "Enter an ID instead", value: null },
      ],
    });

    return choice ?? (yield* typed);
  });

/** Asks what to do after a live setup check fails. */
export const recoverSetupCheck = (name: string) =>
  Prompt.Select({
    message: "What next?",
    choices: [
      { title: "Enter the token again", value: "retry" as const },
      { title: "Continue without checking", value: "continue" as const },
      { title: `Skip ${name} for now`, value: "skip" as const },
    ],
  });
