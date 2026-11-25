import type { GatewayRegistration } from "@poppet/gateway";

interface TextCommand {
  readonly positionals: number;
  readonly values: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<string>;
  readonly strict?: boolean;
}

const textCommands = new Map<string, TextCommand>([
  ["chat new", { positionals: 0, values: ["skill", "attach"], flags: [] }],
  ["chat send", { positionals: 1, values: ["attach"], flags: [] }],
  ["chat rename", { positionals: 1, values: [], flags: ["json"] }],
  ["memory set", { positionals: 1, values: [], flags: ["json"] }],
  [
    "tasks add",
    {
      positionals: 1,
      values: ["in", "at", "cron", "tz", "until", "skill", "to"],
      flags: ["json"],
      strict: true,
    },
  ],
]);

export const helpRequested = (args: ReadonlyArray<string>) => {
  const option = args.find((arg) => arg.startsWith("-"));

  return option === "--help" || option === "-h";
};

export const commandArgs = (
  args: ReadonlyArray<string>,
  gateways: ReadonlyArray<GatewayRegistration>,
): ReadonlyArray<string> => {
  if (args.length === 0) {
    return ["--help"];
  }

  let offset = 2;

  if (args[0] === "gateway" && gateways.some((entry) => entry.id === args[1])) {
    if (helpRequested(args)) {
      return args;
    }
  } else {
    const spec = textCommands.get(`${args[0]} ${args[1]}`);

    if (spec === undefined) {
      return args;
    }

    let positionals = 0;

    while (offset < args.length) {
      const token = args[offset];

      if (token === undefined) {
        break;
      }

      const option = /^--([^=]+)(=?)/.exec(token);
      const optionName = option?.[1];

      if (token === "--" || token === "--help" || token === "-h") {
        return args;
      }

      if (optionName !== undefined && spec.values.includes(optionName)) {
        offset += option?.[2] ? 1 : 2;
      } else if (optionName !== undefined && !option?.[2] && spec.flags.includes(optionName)) {
        offset++;
      } else if (positionals < spec.positionals) {
        if (token.startsWith("-")) {
          return args;
        }

        positionals++;
        offset++;
      } else if (spec.strict && token.startsWith("-")) {
        return args;
      } else {
        break;
      }
    }
  }

  const next = args[offset];

  if (next === undefined || ["--", "--help", "-h"].includes(next)) {
    return args;
  }

  return [...args.slice(0, offset), "--", ...args.slice(offset)];
};
