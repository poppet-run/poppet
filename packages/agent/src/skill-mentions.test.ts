import { describe, expect, test } from "bun:test";

import { mentionedSkills } from "#src/skill-mentions";

describe("mentionedSkills", () => {
  test.each([
    ["Run $deploy on staging", ["deploy"]],
    ["$deploy", ["deploy"]],
    ["Please use $weekly-review.", ["weekly-review"]],
    ['Try ($deploy), "$audit_2"!', ["deploy", "audit_2"]],
    ["First $deploy\nthen $deploy and $audit", ["deploy", "audit"]],
    ["Run `echo $HOME` first", []],
    ["```sh\nexport PATH=$HOME/bin\necho $deploy\n```\nthen $audit", ["audit"]],
    ["```sh\necho $deploy", []],
    ["Use ${deploy} or \\$deploy", []],
    ["cd $HOME/src && FOO=$deploy make", []],
    ["$deploy=1 $deploy.sh $deploy:/bin", []],
    ["It costs $5.00, or US$5", []],
    ["a$deploy $ deploy $", []],
  ])("when the message is %j, names %j", (text, names) => {
    expect(mentionedSkills(text)).toEqual(names);
  });
});
