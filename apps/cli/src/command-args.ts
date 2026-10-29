import type { ChannelRegistration } from "@poppet/gateway";

// Insert `--` so prompts, values, and adapter setup arguments reach their handlers as literal text.
export const commandArgs = (
  args: ReadonlyArray<string>,
  channels: ReadonlyArray<ChannelRegistration>,
): ReadonlyArray<string> => {
  if (args.length === 0) return ["--help"];

  let offset: number;

  if (args[0] === "gateway" && channels.some((entry) => entry.id === args[1])) {
    if (args.includes("--help") || args.includes("-h")) return args;
    offset = 2;
  } else if (args[0] === "chat" && args[1] === "new") {
    offset = 2;

    while (offset < args.length) {
      const token = args[offset]!;

      if (token === "--skill" || token === "--attach") offset += 2;
      else if (token === "--coding" || /^--(?:skill|attach)=/.test(token)) offset++;
      else break;
    }
  } else if (args[0] === "chat" && args[1] === "send") {
    offset = 3;

    while (offset < args.length) {
      const token = args[offset]!;

      if (token === "--attach") offset += 2;
      else if (token.startsWith("--attach=")) offset++;
      else break;
    }
  } else if (args[0] === "chat" && args[1] === "rename") {
    offset = 3;
  } else if (args[0] === "memory" && args[1] === "set") {
    offset = 3;
  } else if (args[0] === "tasks" && args[1] === "add") {
    offset = 3;

    while (offset < args.length) {
      const token = args[offset]!;

      if (["--at", "--cron", "--tz", "--skill", "--to"].includes(token)) offset += 2;
      else if (token === "--coding" || /^--(?:at|cron|tz|skill|to)=/.test(token)) offset++;
      // Unknown options must fail, rather than silently becoming a local task's prompt.
      else if (token.startsWith("-") && token !== "--") return args;
      else break;
    }
  } else return args;

  if (offset >= args.length || ["--", "--help", "-h"].includes(args[offset]!)) return args;

  return [...args.slice(0, offset), "--", ...args.slice(offset)];
};
