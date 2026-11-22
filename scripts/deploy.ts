/**
 * Deploys the Poppet worker to another machine over SSH.
 *
 *   bun run deploy [--host brighid] [--user tom] [--path ~/poppet] [--ref origin/main] [--dry-run]
 *
 * See docs/deploy.md.
 */
import { parseArgs } from "node:util";

export interface DeployOptions {
  readonly host: string;
  readonly user: string | undefined;
  readonly path: string;
  readonly ref: string;
  readonly remote: string | undefined;
  readonly bun: string;
  readonly dryRun: boolean;
}

export const usage = `Usage: bun run deploy [options]

Options:
  --host <host>      SSH host (POPPET_DEPLOY_HOST, default brighid)
  --user <user>      SSH user (POPPET_DEPLOY_USER, default from your SSH config)
  --path <path>      Checkout on the host (POPPET_DEPLOY_PATH, default ~/poppet)
  --ref <ref>        Local ref to deploy (POPPET_DEPLOY_REF, default origin/main)
  --remote <url>     Git URL the host clones (POPPET_DEPLOY_REMOTE, default origin's URL)
  --bun <path>       Bun on the host (POPPET_DEPLOY_BUN, default bun)
  --dry-run          Print the SSH command and remote script without running them
  --help             Show this help`;

/** Reads flags first, then `POPPET_DEPLOY_*` variables, then defaults. */
export const parseOptions = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): DeployOptions | "help" => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      host: { type: "string" },
      user: { type: "string" },
      path: { type: "string" },
      ref: { type: "string" },
      remote: { type: "string" },
      bun: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) return "help";

  return {
    host: values.host ?? env.POPPET_DEPLOY_HOST ?? "brighid",
    user: values.user ?? env.POPPET_DEPLOY_USER,
    path: values.path ?? env.POPPET_DEPLOY_PATH ?? "~/poppet",
    ref: values.ref ?? env.POPPET_DEPLOY_REF ?? "origin/main",
    remote: values.remote ?? env.POPPET_DEPLOY_REMOTE,
    bun: values.bun ?? env.POPPET_DEPLOY_BUN ?? "bun",
    dryRun: values["dry-run"],
  };
};

/** Quotes one word for POSIX `sh`. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Quotes a remote path, expanding a leading `~/` to the remote `$HOME`. */
export const quotePath = (path: string) =>
  path === "~"
    ? '"$HOME"'
    : path.startsWith("~/")
      ? `"$HOME"/${quote(path.slice(2))}`
      : quote(path);

/**
 * `ssh` reads the script on stdin and runs it with `sh -s`, so the remote login
 * shell never parses it. `BatchMode` fails instead of prompting.
 */
export const sshArguments = (host: string, user: string | undefined) => [
  "-o",
  "BatchMode=yes",
  "-T",
  user === undefined ? host : `${user}@${host}`,
  "--",
  "sh",
  "-s",
];

/** The script the host runs. Each step prints its name and fails with a clear message. */
export const remoteScript = (options: {
  readonly path: string;
  readonly commit: string;
  readonly remote: string;
  readonly bun: string;
}) => {
  const bun = quote(options.bun);
  const commit = quote(options.commit);
  const remote = quote(options.remote);
  const poppet = `${bun} apps/cli/src/main.ts`;

  return `set -u
fail() { printf 'deploy: %s\\n' "$1" >&2; exit 1; }
step() { printf '==> %s\\n' "$1"; }
dir=${quotePath(options.path)}

step "Checking git and Bun"
command -v git >/dev/null 2>&1 || fail "git is not on the SSH PATH"
command -v ${bun} >/dev/null 2>&1 || fail ${quote(`${options.bun} is not on the SSH PATH; pass --bun with its absolute path`)}

if [ -d "$dir/.git" ]; then
  step "Checking $dir for local changes"
  changes=$(git -C "$dir" status --porcelain) || fail "git status failed in $dir"
  [ -z "$changes" ] || fail "$dir has local changes; commit, stash, or remove them first:
$changes"
elif [ -e "$dir" ]; then
  fail "$dir exists and is not a git checkout"
else
  step "Cloning into $dir"
  mkdir -p "$(dirname "$dir")" || fail "could not create the parent of $dir"
  git clone --quiet ${remote} "$dir" || fail "git clone failed"
fi

cd "$dir" || fail "could not enter $dir"

step "Fetching ${options.commit}"
if ! git cat-file -e ${quote(`${options.commit}^{commit}`)} 2>/dev/null; then
  git fetch --quiet ${remote} ${commit} 2>/dev/null ||
    git fetch --quiet ${remote} '+refs/heads/*:refs/remotes/deploy/*' || true
  git cat-file -e ${quote(`${options.commit}^{commit}`)} 2>/dev/null ||
    fail "commit ${options.commit} is not on the remote; push it first"
fi

step "Checking out ${options.commit}"
git checkout --quiet --detach ${commit} || fail "git checkout failed"

step "Installing dependencies"
${bun} install --frozen-lockfile || fail "bun install --frozen-lockfile failed"

status=$(${poppet} worker status --json) || fail "poppet worker status failed"
if printf '%s' "$status" | ${bun} -e 'process.exit(JSON.parse(await Bun.stdin.text()).service.installed ? 0 : 1)'; then
  step "Restarting the worker"
  ${poppet} worker restart || fail "poppet worker restart failed"
else
  step "Installing the worker"
  ${poppet} worker install || fail "poppet worker install failed"
fi

printf '\\nDeployed %s to %s\\n\\n' "$(git rev-parse HEAD)" "$dir"
${poppet} worker status || fail "poppet worker status failed"
`;
};

const git = (args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);

  return result.stdout.toString().trim();
};

const main = async () => {
  const options = parseOptions(Bun.argv.slice(2), process.env);

  if (options === "help") return console.log(usage);

  if (options.ref.startsWith("origin/")) git(["fetch", "--quiet", "origin"]);

  const commit = git(["rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`]);
  const remote = options.remote ?? git(["remote", "get-url", "origin"]);
  const script = remoteScript({ path: options.path, commit, remote, bun: options.bun });
  const ssh = ["ssh", ...sshArguments(options.host, options.user)];

  console.log(`Deploying ${options.ref} (${commit}) to ${options.host}:${options.path}`);

  if (options.dryRun) {
    console.log(`\n${ssh.join(" ")} <<'SCRIPT'\n${script}SCRIPT`);

    return;
  }

  const child = Bun.spawn(ssh, {
    stdin: new TextEncoder().encode(script),
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await child.exited;

  if (exitCode === 255) throw new Error(`ssh could not connect to ${options.host}`);

  if (exitCode !== 0) throw new Error(`deploy failed on ${options.host} (exit ${exitCode})`);
};

if (import.meta.main)
  try {
    await main();
  } catch (error) {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
