// Refuses shell commands that skip or disable the Git hooks. Agent harnesses run this
// before each shell command; see docs/development.md#commit-hook-and-agent-guard.

const operators = new Set([";", "&&", "||", "|", "|&", "&", "(", ")", "{", "}", "$(", "`", "\n"]);

const wrappers = new Set([
  "builtin",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);

const shells = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

const mutators = new Set([
  "chmod",
  "cp",
  "install",
  "ln",
  "mv",
  "rm",
  "rmdir",
  "sed",
  "tee",
  "touch",
  "truncate",
  "unlink",
]);

const configReads = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--unset",
  "--unset-all",
  "get",
  "list",
  "unset",
]);

const valueOptions = new Set(["C", "F", "c", "m", "t"]);

export const blockedMessage =
  "Blocked hook bypass: this command skips or disables the Git hooks. Fix the failing check instead.";

const tokenize = (command: string) => {
  const tokens: Array<{ readonly text: string; readonly operator: boolean }> = [];
  let current = "";
  let started = false;
  let index = 0;

  const flush = () => {
    if (started) {
      tokens.push({ text: current, operator: false });
    }

    current = "";
    started = false;
  };

  while (index < command.length) {
    const char = command[index];

    if (char === undefined) {
      break;
    }

    const pair = command.slice(index, index + 2);

    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end === -1 ? command.length : end;
      current += command.slice(index + 1, stop);
      started = true;
      index = stop + 1;
    } else if (char === '"') {
      index += 1;
      started = true;

      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) {
          index += 1;
        }

        current += command[index];
        index += 1;
      }

      index += 1;
    } else if (char === "\\") {
      if (command[index + 1] !== "\n") {
        current += command[index + 1] ?? "";
      }

      started = command[index + 1] !== "\n" || started;
      index += 2;
    } else if (char === "#" && !started) {
      while (index < command.length && command[index] !== "\n") {
        index += 1;
      }
    } else if (operators.has(pair)) {
      flush();
      tokens.push({ text: pair, operator: true });
      index += 2;
    } else if (operators.has(char)) {
      flush();
      tokens.push({ text: char, operator: true });
      index += 1;
    } else if (char === " " || char === "\t" || char === "\r") {
      flush();
      index += 1;
    } else {
      current += char;
      started = true;
      index += 1;
    }
  }

  flush();

  return tokens;
};

const segments = (command: string) => {
  const result: Array<Array<string>> = [[]];

  for (const token of tokenize(command)) {
    if (token.operator) {
      result.push([]);
    } else {
      result.at(-1)?.push(token.text);
    }
  }

  return result.filter((words) => words.length > 0);
};

const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

const bypassingVariable = (name: string, value: string) => {
  if (name === "LEFTHOOK" || name === "HUSKY") {
    return /^(0|false|off|no)$/i.test(value);
  }

  if (name === "LEFTHOOK_EXCLUDE") {
    return value !== "";
  }

  if (name === "GIT_CONFIG_PARAMETERS") {
    return /hookspath/i.test(value);
  }

  return /^GIT_CONFIG_KEY_\d+$/.test(name) && /^core\.hookspath$/i.test(value);
};

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

const skipsVerification = (word: string) =>
  word.length >= "--no-veri".length && "--no-verify".startsWith(word.split("=")[0] ?? "");

const commitSkipsHooks = (args: ReadonlyArray<string>) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined || arg === "--") {
      return false;
    }

    if (arg.startsWith("-") && !arg.startsWith("--")) {
      for (let position = 1; position < arg.length; position += 1) {
        const flag = arg[position];

        if (flag === undefined) {
          break;
        }

        if (flag === "n") {
          return true;
        }

        if (valueOptions.has(flag)) {
          if (position === arg.length - 1) {
            index += 1;
          }

          break;
        }
      }
    }
  }

  return false;
};

const gitBypasses = (args: ReadonlyArray<string>) => {
  let index = 0;

  while (index < args.length) {
    const option = args[index];

    if (option === undefined || !option.startsWith("-")) {
      break;
    }

    if (option === "-c" || option === "--config-env") {
      if (/^core\.hookspath=/i.test(args[index + 1] ?? "")) {
        return true;
      }

      index += 2;
    } else if (/^--config-env=core\.hookspath=/i.test(option)) {
      return true;
    } else if (option === "-C" || option === "--git-dir" || option === "--work-tree") {
      index += 2;
    } else {
      index += 1;
    }
  }

  const subcommand = args[index];
  const rest = args.slice(index + 1);

  if (rest.some(skipsVerification)) {
    return true;
  }

  if (subcommand === "commit" && commitSkipsHooks(rest)) {
    return true;
  }

  return (
    subcommand === "config" &&
    rest.some((arg) => /^core\.hookspath$/i.test(arg)) &&
    !rest.some((arg) => configReads.has(arg))
  );
};

const touchesHooksDirectory = (words: ReadonlyArray<string>) =>
  words.some((word) => /\.git\/hooks\b/.test(word));

const wordsBypass = (input: ReadonlyArray<string>, depth: number): boolean => {
  const words = [...input];

  while (words[0] !== undefined) {
    const match = assignment.exec(words[0]);

    if (match?.[1] === undefined || match[2] === undefined) {
      break;
    }

    if (bypassingVariable(match[1], match[2])) {
      return true;
    }

    words.shift();
  }

  const program = basename(words[0] ?? "");
  const args = words.slice(1);

  // Wrapper options vary, so check every possible start of the wrapped command.
  if (wrappers.has(program)) {
    return args.some((_, index) => wordsBypass(args.slice(index), depth));
  }

  if (program === "export" || program === "declare" || program === "typeset") {
    return args.some((arg) => {
      const match = assignment.exec(arg);

      return (
        match?.[1] !== undefined && match[2] !== undefined && bypassingVariable(match[1], match[2])
      );
    });
  }

  if (program === "set") {
    const [name, value = ""] = args.filter((arg) => !arg.startsWith("-"));

    return name !== undefined && bypassingVariable(name, value);
  }

  if (program === "git" && gitBypasses(args)) {
    return true;
  }

  if (words.some((word) => basename(word) === "lefthook") && args.includes("uninstall")) {
    return true;
  }

  if (mutators.has(program) && touchesHooksDirectory(args)) {
    return true;
  }

  if ((shells.has(program) || program === "eval") && depth < 4) {
    return args.some((arg) => commandBypassesHooks(arg, depth + 1));
  }

  return depth < 4 && args.some((arg) => /\s/.test(arg) && commandBypassesHooks(arg, depth + 1));
};

const redirectTargets = (command: string) =>
  [...command.matchAll(/>>?\s*([^\s;&|]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

export const commandBypassesHooks = (command: string, depth = 0): boolean =>
  segments(command).some((words) => wordsBypass(words, depth)) ||
  touchesHooksDirectory(redirectTargets(command));

type ShellCommand = string | Array<string>;

// Claude Code and Codex send `tool_input.command`; Cursor sends `command`.
const commandFrom = (input: string) => {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Hook stdin is JSON from the agent harness.
  const payload: { tool_input?: { command?: ShellCommand }; command?: ShellCommand } =
    JSON.parse(input);

  const command = payload.tool_input?.command ?? payload.command ?? "";

  return Array.isArray(command) ? command.join(" ") : command;
};

// Claude Code and Codex read a refusal from exit code 2 and stderr, and treat other
// stdout as hook output. Cursor runs this with `cursor` and expects a JSON decision.
if (import.meta.main) {
  const cursor = Bun.argv[2] === "cursor";
  const refused = commandBypassesHooks(commandFrom(await Bun.stdin.text()));

  if (cursor) {
    console.log(
      JSON.stringify(
        refused
          ? { permission: "deny", user_message: blockedMessage, agent_message: blockedMessage }
          : { permission: "allow" },
      ),
    );
  }

  if (refused) {
    console.error(blockedMessage);
    process.exit(2);
  }
}
