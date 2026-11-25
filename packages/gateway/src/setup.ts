import { parseArgs } from "node:util";

import { Effect } from "effect";

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
