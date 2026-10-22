import type { ChannelRegistration } from "@poppet/gateway";

// The old CLI treated the rest of a prompt/value, and adapter setup arguments,
// as literal text. Shield those tokens from option parsing with the CLI's `--`.
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

      if (token === "--skill" || token === "--project") offset += 2;
      else if (token === "--coding" || /^--(?:skill|project)=/.test(token)) offset++;
      else break;
    }
  } else if (args[0] === "chat" && ["send", "rename"].includes(args[1] ?? "")) {
    offset = 3;
  } else if (args[0] === "memory" && ["remember", "replace"].includes(args[1] ?? "")) {
    offset = 2;

    while (args[offset] === "--project" || args[offset]?.startsWith("--project="))
      offset += args[offset] === "--project" ? 2 : 1;
    offset++;

    while (args[offset] === "--project" || args[offset]?.startsWith("--project="))
      offset += args[offset] === "--project" ? 2 : 1;
  } else if (args[0] === "tasks" && args[1] === "add") {
    offset = 3;

    while (offset < args.length) {
      const token = args[offset]!;

      if (
        [
          "--at",
          "--cron",
          "--tz",
          "--skill",
          "--project",
          "--discord-thread",
          "--telegram-chat",
          "--whatsapp-chat",
        ].includes(token)
      )
        offset += 2;
      else if (
        token === "--coding" ||
        token === "--monitor" ||
        /^--(?:at|cron|tz|skill|project|discord-thread|telegram-chat|whatsapp-chat)=/.test(token)
      )
        offset++;
      else break;
    }
  } else return args;

  if (offset >= args.length || ["--", "--help", "-h"].includes(args[offset]!)) return args;

  return [...args.slice(0, offset), "--", ...args.slice(offset)];
};
