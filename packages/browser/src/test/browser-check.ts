import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { Effect, type Schema } from "effect";

import { browserTools } from "#src/browser";
import { launchBrowserProcess, type BrowserLauncher } from "#src/browser-process";

const [command, chromiumExecutable] = Bun.argv.slice(2);

let localhostRequests = 0;

let resourceRequests = 0;

const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request): Response => {
    const url = new URL(request.url);

    if (url.hostname === "localhost") {
      localhostRequests++;

      if (url.pathname === "/resource") resourceRequests++;
    }

    if (url.pathname === "/redirect")
      return Response.redirect(`http://localhost:${site.port}/blocked`);

    return new Response(
      `<!doctype html><title>Browser fixture</title>
      <h1>Fixture page</h1><form><label>Name <input name="name"></label>
      <button>Submit fixture</button></form><p id="result"></p><p id="rtc"></p>
      <img src="http://localhost:${site.port}/resource">
      <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();
      document.querySelector('#result').textContent='Saved '+new FormData(e.target).get('name')};
      document.querySelector('h1').textContent='Rendered fixture';
      try { const peer=new RTCPeerConnection(); peer.close();
      document.querySelector('#rtc').textContent='WebRTC enabled'; }
      catch { document.querySelector('#rtc').textContent='WebRTC blocked'; }</script>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

const directories = new Set<string>();

const daemons: ReturnType<BrowserLauncher>[] = [];

const launch: BrowserLauncher = (args, directory, environment) => {
  directories.add(directory);
  const child = launchBrowserProcess(args, directory, environment);

  if (environment.AGENT_BROWSER_DAEMON === "1") daemons.push(child);

  return child;
};

const settings = {
  enabled: true,
  ...(command === undefined ? undefined : { command }),
  ...(chromiumExecutable === undefined ? undefined : { chromiumExecutable }),
  allowedDomains: ["127.0.0.1"],
};

const workflow = (scenario: "page" | "redirect" | "wildcard") =>
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* browserTools(
        { ...settings, allowedDomains: scenario === "wildcard" ? ["*"] : settings.allowedDomains },
        crypto.randomUUID(),
        16384,
        launch,
      );

      const call = (name: string, input: Schema.JsonObject = {}) =>
        Effect.gen(function* () {
          const tool = tools.find((entry) => entry.toolName === name);
          assert(tool);
          const prepared = yield* tool.prepare(JSON.stringify(input));

          return yield* prepared.execute;
        });

      if (scenario === "wildcard") {
        yield* call("open", { url: `http://127.0.0.1:${site.port}/` });

        const result = JSON.parse(
          yield* call("open", { url: `http://127.0.0.1:${site.port}/redirect` }),
        );

        assert.equal(result.url, `http://localhost:${site.port}/blocked`);
        const snapshot = JSON.parse(yield* call("snapshot"));
        assert.match(snapshot.text, /Rendered fixture/);
        assert.match(snapshot.text, /WebRTC blocked/);

        return;
      }

      if (scenario === "redirect") {
        const failed = yield* call("open", { url: `http://127.0.0.1:${site.port}/redirect` }).pipe(
          Effect.flip,
        );

        assert(failed.reason);

        return;
      }

      yield* call("open", { url: `http://127.0.0.1:${site.port}/` });
      const snapshot = JSON.parse(yield* call("snapshot"));
      assert.match(snapshot.text, /Rendered fixture/);
      assert.match(snapshot.text, /WebRTC blocked/);
      assert.doesNotMatch(snapshot.text, /Saved Tom/);
      yield* call("press", { key: "Tab" });
      yield* call("scroll", { direction: "down", pixels: 200 });
      const current = JSON.parse(yield* call("snapshot"));
      const reference = /textbox "Name" \[ref=(e\d+)\]/.exec(current.text)?.[1];
      assert(reference, snapshot.text);
      yield* call("fill", { reference: `@${reference}`, text: "Tom" });
      const filled = JSON.parse(yield* call("snapshot"));
      const submit = /button "Submit fixture" \[ref=(e\d+)\]/.exec(filled.text)?.[1];
      assert(submit, filled.text);
      yield* call("click", { reference: `@${submit}` });
      const result = JSON.parse(yield* call("snapshot"));
      assert.match(result.text, /Saved Tom/);
      assert.equal(result.url, `http://127.0.0.1:${site.port}/`);

      const denied = yield* call("open", { url: `http://localhost:${site.port}/blocked` }).pipe(
        Effect.flip,
      );

      assert.equal(denied.reason, "tool-arguments");
    }),
  );

try {
  await Effect.runPromise(workflow("page"));
  await Effect.runPromise(workflow("redirect"));
  assert.equal(localhostRequests, 0, "A forbidden navigation or subresource reached the fixture.");
  await Effect.runPromise(workflow("wildcard"));
  assert(localhostRequests > 0, "Wildcard navigation did not reach the second host.");
  assert(resourceRequests > 0, "Wildcard subresources did not reach the second host.");
  assert(
    daemons.length === 3 &&
      daemons.every((child) => child.exitCode !== null || child.signalCode !== null),
  );

  await Promise.all(
    [...directories].map(async (directory) => {
      assert.equal(
        await access(directory).then(
          () => true,
          () => false,
        ),
        false,
        "Browser state was retained.",
      );
    }),
  );

  console.log(
    "Pinned browser check passed: JavaScript, form action, restricted and wildcard navigation/redirect/subresource, WebRTC blocking, isolated runs, and daemon cleanup.",
  );
} finally {
  site.stop(true);
}
