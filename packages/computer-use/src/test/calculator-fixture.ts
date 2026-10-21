import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { Schema } from "effect";

import fixture from "./fixtures/calculator-schemas.json";

const [directory = "/tmp", mode = "normal"] = process.argv.slice(2);

writeFileSync(`${directory}/pid`, String(process.pid));

let generation = 0;

let presses = 0;

let ended = false;

const labels = ["All Clear", "1", "2", "Add", "7", "Equals"];

const reply = (id: Schema.Json, result: Schema.JsonObject) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        id: Schema.optionalKey(Schema.Json),
        method: Schema.String,
        params: Schema.optionalKey(Schema.JsonObject),
      }),
    ),
  )(line);

  if (request.id === undefined) return;

  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });

    return;
  }

  if (request.method === "tools/list") {
    reply(request.id, {
      tools:
        mode === "unexpected-tool"
          ? [...fixture.tools, { name: "screenshot", inputSchema: { type: "object" } }]
          : fixture.tools,
    });

    return;
  }

  if (request.method !== "tools/call") return;
  const name = request.params?.name;
  const args = Schema.decodeUnknownSync(Schema.JsonObject)(request.params?.arguments);
  appendFileSync(`${directory}/events`, `${JSON.stringify({ name, args })}\n`);

  const refuse = (code = "permission_denied") =>
    reply(request.id!, { isError: true, content: [], structuredContent: { code } });

  const result = (data: Schema.JsonObject) =>
    reply(request.id!, { content: [], structuredContent: data });

  if (args.session !== "poppet-calculator-22a") return refuse();

  if (name === "check_permissions") {
    if (args.prompt !== false || args.probe_direct_capture !== false) return refuse();

    return result({
      accessibility: mode !== "accessibility-denied",
      screen_recording: false,
      source: { attribution: "host" },
    });
  }

  if (name === "launch_app") {
    if (args.bundle_id !== "com.apple.calculator" || args.urls) return refuse();

    return result({
      pid: 100,
      bundle_id: "com.apple.calculator",
      windows: [
        {
          pid: 100,
          window_id: 200,
          is_on_screen: true,
          on_current_space: mode === "unknown-space" ? null : true,
        },
        { pid: 100, window_id: 201, is_on_screen: false, on_current_space: null },
      ],
    });
  }

  if (name === "get_window_state") {
    if (ended)
      return refuse(mode === "wrong-revocation-code" ? "permission_denied" : "session_ended");

    if (args.pid !== 100 || args.include_screenshot !== false || args.screenshot_out_file)
      return refuse();

    if (mode === "screen-locked")
      return result({
        pid: 100,
        window_id: 200,
        degraded_reason:
          "screen_locked: window_id 200 has no accessibility tree because the screen is locked.",
      });
    generation++;
    const snapshot = `s${generation.toString(16).padStart(8, "0")}`;

    return result({
      pid: 100,
      window_id: mode === "wrong-window" ? 201 : 200,
      snapshot_id: snapshot,
      tree_markdown: `- AXStaticText = "${presses === 6 && mode !== "wrong-display" ? "19" : "0"}" (Edit field)`,
      elements: labels.map((label, i) => ({
        element_index: i,
        role: "AXButton",
        depth: 1,
        label,
        actions: ["AXPress"],
        element_token: `${snapshot}:${i}`,
      })),
    });
  }

  if (name === "click") {
    if (args.x !== undefined || args.delivery_mode !== "background" || args.button !== "left")
      return refuse();

    if (args.element_token !== `s${generation.toString(16).padStart(8, "0")}:${presses}`)
      return refuse(mode === "wrong-stale-code" ? "permission_denied" : "stale_element_token");
    presses++;
    appendFileSync(`${directory}/presses`, `${presses}\n`);

    if (mode === "disconnect") process.exit(0);

    if (mode === "hang") return;

    if (mode === "media")
      return reply(request.id, {
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        structuredContent: { route: "accessibility", effect: "unverifiable" },
      });

    if (mode === "invalid-output") return result({ route: "accessibility" });

    return result({
      route: mode === "pixel-route" ? "synthetic_events" : "accessibility",
      effect: mode === "refused-effect" ? "refused" : "unverifiable",
    });
  }

  if (name === "end_session") {
    ended = true;

    return result({ active: false, session: args.session });
  }

  return refuse();
});
