import type { ChannelRegistration } from "@poppet/gateway";

interface TextCommand {
  /** Positional arguments before the literal text. */
  readonly positionals: number;
  /** Options that take a value. */
  readonly values: ReadonlyArray<string>;
  /** Options that take no value. */
  readonly flags: ReadonlyArray<string>;
  /** Fail on unknown options instead of treating them as the start of the text. */
  readonly strict?: boolean;
}

const textCommands = new Map<string, TextCommand>([
  ["chat new", { positionals: 0, values: ["skill", "attach"], flags: [] }],
  ["chat send", { positionals: 1, values: ["attach"], flags: [] }],
  ["chat rename", { positionals: 1, values: [], flags: ["json"] }],
  ["memory set", { positionals: 1, values: [], flags: ["json"] }],
  // Unknown options must fail, rather than silently becoming a local task's prompt.
  [
    "tasks add",
    {
      positionals: 1,
      values: ["in", "at", "cron", "tz", "skill", "to"],
      flags: ["json"],
      strict: true,
    },
  ],
]);

// Insert `--` so prompts, values, and adapter setup arguments reach their handlers as literal text.
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
