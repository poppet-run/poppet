import type { ChannelRegistration } from "@poppet/gateway";

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

export const commandArgs = (
  args: ReadonlyArray<string>,
  channels: ReadonlyArray<ChannelRegistration>,
): ReadonlyArray<string> => {
  if (args.length === 0) return ["--help"];

  let offset = 2;

  if (args[0] === "gateway" && channels.some((entry) => entry.id === args[1])) {
    if (args.includes("--help") || args.includes("-h")) return args;
  } else {
    const spec = textCommands.get(`${args[0]} ${args[1]}`);

    if (spec === undefined) return args;
    let positionals = 0;

    while (offset < args.length) {
      const token = args[offset]!;
      const option = /^--([^=]+)(=?)/.exec(token);

      if (token === "--" || token === "--help" || token === "-h") return args;

      if (option !== null && spec.values.includes(option[1]!)) offset += option[2] ? 1 : 2;
      else if (option !== null && !option[2] && spec.flags.includes(option[1]!)) offset++;
      else if (positionals < spec.positionals) {
        if (token.startsWith("-")) return args;
        positionals++;
        offset++;
      } else if (spec.strict && token.startsWith("-")) return args;
      else break;
    }
  }

  if (offset >= args.length || ["--", "--help", "-h"].includes(args[offset]!)) return args;

  return [...args.slice(0, offset), "--", ...args.slice(offset)];
};
