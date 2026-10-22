# Browser automation

[Documentation index](README.md)

Poppet uses agent-browser to navigate websites, read rendered text and
accessibility snapshots, and perform explicitly requested form interactions.
Browser tools are optional in CLI, worker-backed, and authorized messaging chats.
Scheduled runs receive no browser tools.

`@poppet/browser` owns the tools, settings, and isolated process lifecycle. The CLI
composes them with MCP tools through the agent's external-tool contract.

## Install and configure

The integration pins agent-browser **0.39.1** and Chrome for Testing
**155.0.8059.84**, on macOS and Linux. For example, install the CLI with Node 24 or
later and npm:

```sh
npm install -g agent-browser@0.39.1
agent-browser --version
command -v agent-browser
```

Use the native binary, not the JavaScript launcher. Global npm installation
normally links to it. It also lives under the package's `bin` directory, named
`agent-browser-darwin-arm64`, `agent-browser-darwin-x64`, or the corresponding
Linux binary. Poppet must own that exact daemon process.

Download and extract the pinned browser to a stable location:

| Platform            | Download                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Apple silicon macOS | [mac-arm64](https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/mac-arm64/chrome-mac-arm64.zip) |
| Intel macOS         | [mac-x64](https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/mac-x64/chrome-mac-x64.zip)       |
| Linux x64           | [linux64](https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/linux64/chrome-linux64.zip)       |

`agent-browser install` selects current stable Chrome, which may differ from this
pin. Use the testing browser without your everyday Chrome profile. Add this
section to your existing `<data directory>/config.json`:

```json
{
  "browser": {
    "enabled": true,
    "command": "/absolute/path/to/agent-browser-darwin-arm64",
    "chromiumExecutable": "/absolute/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "allowedDomains": ["example.com", "www.example.com"]
  }
}
```

`command` defaults to `agent-browser` on `PATH`; prefer an absolute path for the
worker. File command paths containing `/` resolve beside `config.json`.
`chromiumExecutable` must be absolute. For restricted browsing, allow 1–32 exact
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

`POPPET_BROWSER` replaces the complete file section. `{"enabled":false}` disables
access. `poppet config` shows the invoking process's settings without
launching a browser. Restart the worker after edits. Missing executables or wrong
versions produce a sanitized diagnostic and omit browser tools while ordinary
chat and MCP tools remain available. Poppet never installs or upgrades software.

## Use and lifecycle

```sh
poppet chat new "Use the browser to open https://example.com and summarize its rendered page"
```

Tools are `poppet_browser.open`, `snapshot`, `click`, `fill`, `press`, `scroll`, and
`close`. Inspect a snapshot before clicking/filling its current element references;
both `e1` and `@e1` are accepted and checked against that snapshot. Always
refresh it after interacting. Individual navigation/editing keys are supported,
without arbitrary shortcuts. Form values travel as structured data and cannot
become flags. Closing ends browser use for that run.

Every run has a fresh private home, directory, namespace, daemon, and browser.
Cookies, tabs, login state, and references do not persist between messages.
Fixed native commands use the pinned CLI daemon's private Unix socket. Native
MCP was checked, but its session/launch overrides and detached CLI lifecycle do
not directly meet these ownership requirements. Existing MCP tools remain available.

Results contain the current URL, text, and a `truncated` flag within
`POPPET_TOOL_BYTES`. Raw responses and each process pipe are capped at 256 KiB,
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
expand domains, mutate notes/memory/tasks, or grant `fetch_page` access. Model
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
bun packages/browser/src/test/browser-check.ts /absolute/path/to/agent-browser /absolute/path/to/chromium
```

It checks JavaScript rendering, a form action, restricted and wildcard navigation,
redirects and subresources, WebRTC blocking, isolated runs, and daemon cleanup.
Local socket access is required; it does not call an inference provider. Live-model CLI and authorized
messaging completion remain manual. Use a disposable allowed site, inspect saved
calls, cancel a running workflow, and stop the worker to verify cleanup.
