import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { Effect, type Schema } from "effect";

import { browserTools } from "#src/browser";
import { launchBrowserProcess, type BrowserLauncher } from "#src/browser-process";

const [command, chromiumExecutable] = Bun.argv.slice(2);

assert(
  command && chromiumExecutable,
  "Pass the pinned agent-browser and Chrome for Testing executable paths.",
);

let blockedRequests = 0;

const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request): Response => {
    const url = new URL(request.url);

    if (url.hostname === "localhost") blockedRequests++;

    if (url.pathname === "/redirect")
      return Response.redirect(`http://localhost:${site.port}/blocked`);

    return new Response(
      `<!doctype html><title>Browser fixture</title>
      <h1>Fixture page</h1><form><label>Name <input name="name"></label>
      <button>Submit fixture</button></form><p id="result"></p>
      <img src="http://localhost:${site.port}/blocked">
      <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();
      document.querySelector('#result').textContent='Saved '+new FormData(e.target).get('name')};
      document.querySelector('h1').textContent='Rendered fixture';</script>`,
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

const settings = { enabled: true, command, chromiumExecutable, allowedDomains: ["127.0.0.1"] };

const workflow = (redirect: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* browserTools(settings, crypto.randomUUID(), 16384, launch);

      const call = (name: string, input: Schema.JsonObject = {}) =>
        Effect.gen(function* () {
          const tool = tools.find((entry) => entry.toolName === name);
          assert(tool);
          const prepared = yield* tool.prepare(JSON.stringify(input));

          return yield* prepared.execute;
        });

      if (redirect) {
        const failed = yield* call("open", { url: `http://127.0.0.1:${site.port}/redirect` }).pipe(
          Effect.flip,
        );

        assert(failed.reason);

        return;
      }

      yield* call("open", { url: `http://127.0.0.1:${site.port}/` });
      const snapshot = JSON.parse(yield* call("snapshot"));
      assert.match(snapshot.text, /Rendered fixture/);
      assert.doesNotMatch(snapshot.text, /Saved Tom/);
      const reference = /textbox "Name" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
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
      yield* call("close");
    }),
  );

try {
  await Effect.runPromise(workflow(false));
  await Effect.runPromise(workflow(true));
  assert.equal(blockedRequests, 0, "A forbidden navigation or subresource reached the fixture.");
  assert(
    daemons.length === 2 &&
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
    "Pinned browser check passed: JavaScript, form action, denied navigation/redirect/subresource, isolated runs, and daemon cleanup.",
  );
} finally {
  site.stop(true);
}
