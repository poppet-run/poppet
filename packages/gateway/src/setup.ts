import { parseArgs } from "node:util";

import { Effect } from "effect";

import { ChannelError } from "#src/channel";

export const parseSetupFlags = (
  args: ReadonlyArray<string>,
  adapter: string,
  help: string,
  names: ReadonlyArray<string>,
) =>
  Effect.try({
    try: () => {
      if (args[0] !== "setup") throw new Error("Expected setup");
      const options = Object.fromEntries(names.map((name) => [name, { type: "string" as const }]));

      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options,
        strict: true,
        allowPositionals: false,
        tokens: true,
      });

      const supplied = tokens.filter((token) => token.kind === "option").map((token) => token.name);

      if (supplied.length !== names.length || new Set(supplied).size !== names.length)
        throw new Error("Expected each setup flag exactly once");

      return values;
    },
    catch: () =>
      new ChannelError({ reason: "configuration", message: `Use gateway ${adapter} ${help}.` }),
  });
