import { describe, expect, test } from "bun:test";

import { commandBypassesHooks } from "./hook-bypass.ts";

describe("commandBypassesHooks", () => {
  test.each([
    "git commit --no-verify -m wip",
    "git commit --no-veri -m wip",
    "git push --no-verify",
    "git commit -n -m wip",
    "git commit -nm wip",
    "git commit -am wip -n",
    "git -C apps/cli commit -n",
    "git -c core.hooksPath=/dev/null commit -m wip",
    "git config core.hooksPath /dev/null",
    "git config --local core.hooksPath .nohooks",
    "LEFTHOOK=0 git commit -m wip",
    "LEFTHOOK=false git commit -m wip",
    "HUSKY=0 git commit -m wip",
    "LEFTHOOK_EXCLUDE=check git commit -m wip",
    "export LEFTHOOK=0",
    "set -gx LEFTHOOK 0",
    "env LEFTHOOK=0 git commit -m wip",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit",
    "bunx lefthook uninstall",
    "rm -f .git/hooks/pre-commit",
    "echo exit 0 > .git/hooks/pre-commit",
    "bun run format && git commit --no-verify -m wip",
    "bash -c 'git commit -n -m wip'",
    'sh -c "cd apps && git commit --no-verify"',
    'echo "$(git commit -n -m wip)"',
    "sudo -u me git commit -n",
  ])("when the command is %j, refuses it", (command) => {
    expect(commandBypassesHooks(command)).toBe(true);
  });

  test.each([
    "git commit -m wip",
    "git commit -m 'Refuse git commit -n in agents'",
    "git commit -F message.txt",
    "git commit --amend --no-edit",
    "git push origin HEAD",
    "git config --get core.hooksPath",
    "git config --unset core.hooksPath",
    "git log --oneline -n 5",
    "LEFTHOOK=1 git commit -m wip",
    "ls .git/hooks",
    "rg --no-verify docs",
    "bun run check",
  ])("when the command is %j, allows it", (command) => {
    expect(commandBypassesHooks(command)).toBe(false);
  });
});
