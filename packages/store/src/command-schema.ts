import { Schema } from "effect";

const Text = Schema.String.check(
  Schema.makeFilter((text) => !text.includes("\0") && text.isWellFormed()),
);

export const CommandArguments = Schema.Struct({
  executable: Text.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  args: Schema.Array(Text).check(
    Schema.isMaxLength(128),
    Schema.makeFilter(
      (args) => args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) <= 16384,
    ),
  ),
  cwd: Text.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});

export type CommandArguments = typeof CommandArguments.Type;

export const CommandTemplate = Schema.Struct({
  ...CommandArguments.fields,
  root: Text.check(Schema.isPattern(/^\//), Schema.isMaxLength(4096)),
});

export const CommandDirectory = Schema.Struct({
  path: Schema.NonEmptyString,
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
});

export const CommandExecutable = Schema.Struct({
  ...CommandDirectory.fields,
  digest: Schema.NonEmptyString,
});

export const CommandGrant = Schema.Struct({ root: CommandDirectory });

export type CommandGrant = typeof CommandGrant.Type;

export const CommandProposal = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("execute_command"),
  request: CommandArguments,
  executable: CommandExecutable,
  cwd: CommandDirectory,
  grant: CommandGrant,
  project: Schema.NullOr(Schema.String),
  policy: Schema.Literal(1),
  environment: Schema.Struct({
    PATH: Schema.Literal("/usr/bin:/bin"),
    LANG: Schema.Literal("C"),
    HOME: Schema.Literal("private-temporary"),
    TMPDIR: Schema.Literal("private-temporary"),
  }),
  timeoutMs: Schema.Literal(60000),
  outputBytes: Schema.Literal(65536),
});

export type CommandProposal = typeof CommandProposal.Type;
