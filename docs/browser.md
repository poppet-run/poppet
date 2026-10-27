# Browser automation

[Documentation index](README.md)

Poppet uses agent-browser to navigate websites, read rendered text and
accessibility snapshots, and perform explicitly requested form interactions.
Browser tools are optional in CLI, worker-backed, and authorized messaging chats.
Scheduled runs receive no browser tools.

`@poppet/browser` owns the tools, settings, and isolated process lifecycle. The CLI
composes them with MCP tools through the agent's external-tool contract.

## Install and configure

The integration pins agent-browser **0.39.4** and Chrome for Testing
**156.0.8078.47**, on macOS and Linux. For example, install the CLI with Node 24 or
later and npm:

```sh
npm install -g agent-browser@0.39.4
agent-browser --version
command -v agent-browser
```

Poppet finds `agent-browser` on `PATH` and follows symlinks. For npm and Homebrew
JavaScript launchers, it selects the platform's native binary beside the launcher
so it can own that exact daemon process. The worker's `PATH` must include the
installation, or you can set `command` to the native executable explicitly.

Download and extract the pinned browser into
`~/.agent-browser/browsers/chrome-156.0.8078.47/`:

| Platform            | Download                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Apple silicon macOS | [mac-arm64](https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/mac-arm64/chrome-mac-arm64.zip) |
| Intel macOS         | [mac-x64](https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/mac-x64/chrome-mac-x64.zip)       |
| Linux x64           | [linux64](https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-linux64.zip)       |

`agent-browser install` selects current stable Chrome, which may differ from this
pin. Use the testing browser without your everyday Chrome profile. Add this
section to your existing `<data directory>/config.json`:

```json
{
  "browser": {
    "enabled": true,
    "allowedDomains": ["example.com", "www.example.com"]
  }
}
```

Both executable settings are optional overrides. `command` selects a native
agent-browser executable; file command paths containing `/` resolve beside
`config.json`. `chromiumExecutable` must be absolute when provided. Otherwise,
Poppet finds the pinned Chrome in the invoking user's agent-browser cache before
isolating the run's `HOME`. Both the installer's flattened layout and the original
archive's platform directory are supported. Discovery never selects a different
version or uses your everyday Chrome. For restricted browsing, allow 1–32 exact
lowercase hostnames without schemes, ports, paths, or wildcards. Include required
CDN hosts explicitly. An allowed hostname covers its ports.

Set `"allowedDomains": ["*"]` to allow every HTTP(S) hostname, including localhost
and private networks. This also removes hostname filtering for redirects, new
tabs, and subresources. Other wildcard patterns such as `*.example.com` remain
unsupported. Missing or empty lists never enable unrestricted browsing.
HTTP(S)-only navigation, rejection of embedded URL credentials, isolated browser
state, fixed actions, WebRTC blocking, and output limits still apply. Wildcard
mode preserves WebRTC blocking with a fixed host-owned startup script and
Chrome's restriction on non-proxied UDP; it exposes no script or launch options
to the model.

Set `browser.enabled` to `false` in `config.json` to disable
access. `poppet config` shows the invoking process's settings without
launching a browser. Restart the worker after edits. Executables and versions are checked only on the first browser action. Missing
executables or wrong versions fail that action with a sanitized diagnostic;
unused browser support does not interfere with ordinary chat or MCP tools. Poppet never installs or upgrades software.

## Use and lifecycle

```sh
poppet chat new "Use the browser to open https://example.com and summarize its rendered page"
```

Tools are `poppet_browser.open`, `snapshot`, `click`, `fill`, `press`, and
`scroll`. Inspect a snapshot before clicking/filling its current element references;
both `e1` and `@e1` are accepted and checked against that snapshot. Always
refresh it after interacting. Individual navigation/editing keys are supported,
without arbitrary shortcuts. Form values travel as structured data and cannot
become flags. The browser closes automatically when the run ends.

The first browser action creates a fresh private home, directory, namespace,
daemon, and browser, reused for the rest of that run. Publishing tools and
validating arguments create no files or processes.
Cookies, tabs, login state, and references do not persist between messages.
Fixed native commands use the pinned CLI daemon's private Unix socket. Native
MCP was checked, but its session/launch overrides and detached CLI lifecycle do
not directly meet these ownership requirements. Existing MCP tools remain available.

Results contain the current URL, text, and a `truncated` flag within
the 16 KiB tool-output limit. Raw responses and each process pipe are capped at 256 KiB,
arguments at 64 KiB, form text at 8192 characters, and snapshot depth at 12.
Oversized raw responses fail. Version probes and readiness have five-second
deadlines; native requests have 35 seconds, and element waits default to ten
seconds. Existing run and call budgets remain in force.

Completion, failure, Ctrl-C, timeout, and worker shutdown release run resources.
Graceful daemon shutdown can take up to 40 seconds while the runtime closes its
browser process tree. Cleanup failures are reported. Saved calls use
`serverId: "browser"` and the operation name in `chat show`. Lost responses or
cancellation after dispatch leave uncertain calls. Inspect external state before
requesting another attempt; actions are never automatically replayed.

## Permissions and limits

Clicks, filling, and Enter can submit forms or change external state. Request
those actions explicitly. Page text is untrusted and cannot authorize actions,
expand domains, mutate memory/tasks, or grant `fetch_page` access. Model
instructions preserve these boundaries; they do not prove a click is harmless.

The daemon receives a deny-by-default action policy before navigation. When
`allowedDomains` has no `"*"` entry, it also receives hostname restrictions that
apply to redirects, new tabs, and subresources.
Poppet supplies private settings and a minimal environment without provider keys,
channel tokens, ambient plugins, saved profiles, or inherited launch flags. Model
arguments cannot change the session, executable, domains, or policy.

Browser traffic does not use the page reader's public-IP/DNS checks. Allowed
hosts can resolve to private addresses; this is not an OS network sandbox. Only
allow hosts you trust. See upstream [security limitations](https://agent-browser.dev/security).
Persistent login state, auth-vault access, browser attachments, arbitrary JavaScript,
uploads/downloads, clipboard access, screenshots, PDFs, cloud browsers, and a
general approval workflow remain outside this phase.

## Validation

Run `bun run check` for fixture and injected-model tests. With pinned executables,
run the standalone local-site self-check:

```sh
bun packages/browser/src/test/browser-check.ts
```

It checks JavaScript rendering, a form action, restricted and wildcard navigation,
redirects and subresources, WebRTC blocking, isolated runs, and daemon cleanup.
Local socket access is required; it does not call an inference provider. Live-model CLI and authorized
messaging completion remain manual. Use a disposable allowed site, inspect saved
calls, cancel a running workflow, and stop the worker to verify cleanup.
