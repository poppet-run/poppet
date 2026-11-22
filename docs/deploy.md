# Deploy

[Documentation index](README.md)

`bun run deploy` deploys the background [worker](worker.md) to another machine over SSH.
By default it deploys `origin/main` to `brighid`, reached through Tailscale MagicDNS.
The script is `scripts/deploy.ts`. It never deletes the host's checkout, data directory,
credentials, or logs.

## Requirements

On the machine you deploy from:

- This checkout, with dependencies installed.
- The system `ssh` client. The script uses your `~/.ssh/config`, SSH agent, and
  MagicDNS names, and runs with `BatchMode=yes`, so the host key must already be
  trusted and authentication must not prompt.

On the host:

- SSH access for your user. With Tailscale, `ssh brighid` should work without a
  password prompt.
- `git` and Bun 1.4.4 on the `PATH` of a non-interactive SSH session. Check with
  `ssh brighid 'command -v git bun'`. If Bun is set up only for interactive shells,
  pass `--bun` with its absolute path.
- Read access to the Git remote. The default is this checkout's `origin` URL. An SSH
  URL such as `git@github.com:poppet-run/poppet.git` needs a GitHub key on the host;
  otherwise pass `--remote https://github.com/poppet-run/poppet.git`.
- On Linux, systemd user services. Enable lingering once so the worker keeps running
  without a login session: `loginctl enable-linger`.

## First deploy

1. Push the commit you want to deploy. The host fetches it from the remote.
2. Preview the commands:

   ```sh
   bun run deploy:dry-run
   ```

3. Deploy:

   ```sh
   bun run deploy
   ```

4. On the host, run [setup](getting-started.md#run-setup) from the checkout if Poppet
   is not configured there yet: save `config.json` and sign in to a provider. Then run
   `bun run deploy` again, or `poppet worker restart` on the host.

## What a deploy does

The script resolves `--ref` to a commit locally, after `git fetch origin` when the ref
starts with `origin/`. It then sends one script to the host over `ssh ... sh -s`. On the
host it:

1. Checks that `git` and Bun are on the `PATH`.
2. Refuses a checkout with uncommitted or untracked changes, or a path that exists but
   is not a Git checkout. Clones the remote when the path does not exist.
3. Fetches the commit unless it is already present, and checks it out detached.
4. Runs `bun install --frozen-lockfile`.
5. Runs `poppet worker install` when no worker service is installed for the checkout,
   otherwise `poppet worker restart`.
6. Prints the deployed commit and `poppet worker status`.

Each step prints its name. A failing step stops the deploy and prints `deploy:` with
the reason. When `ssh` cannot connect, the script says so.

## Options

Flags take precedence over environment variables:

| Flag        | Variable               | Default                      |
| ----------- | ---------------------- | ---------------------------- |
| `--host`    | `POPPET_DEPLOY_HOST`   | `brighid`                    |
| `--user`    | `POPPET_DEPLOY_USER`   | from your SSH configuration  |
| `--path`    | `POPPET_DEPLOY_PATH`   | `~/poppet` on the host       |
| `--ref`     | `POPPET_DEPLOY_REF`    | `origin/main`                |
| `--remote`  | `POPPET_DEPLOY_REMOTE` | this checkout's `origin` URL |
| `--bun`     | `POPPET_DEPLOY_BUN`    | `bun`                        |
| `--dry-run` |                        | off                          |

Pass flags after `--`, for example `bun run deploy -- --ref v1.2.0`. `--dry-run`
resolves the commit and prints the `ssh` command and remote script without running them.

The worker uses its default data directory on the host. To remove the service, run
`poppet worker uninstall` in the checkout on the host.
