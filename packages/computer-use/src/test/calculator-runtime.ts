import assert from "node:assert/strict";

import type { CallToolResult } from "@modelcontextprotocol/client";
import { compileSchema } from "@poppet/mcp/catalog";
import { Schema } from "effect";

import { calculatorResult, discoverCalculatorTools, type CalculatorDriver } from "#src/driver";

export { openCalculatorDriver, calculatorEnvironment, calculatorResult, alive } from "#src/driver";

export const calculatorSession = "poppet-calculator-22a";

export const calculatorManifest = {
  version: 3,
  expires_after: "5m",
  idle_timeout: "5m",
  allow: { tools: ["check_permissions", "launch_app", "get_window_state", "click", "end_session"] },
  resources: {
    apps: [{ bundle_id: "com.apple.calculator", launch: true, windows: "all" }],
    desktop: { display: false },
  },
};

// YAML listing checks rule existence; this layer blocks Rego's empty discovery sentinel on calls.
export const calculatorGuard = {
  allow: {
    rules: calculatorManifest.allow.tools.map((tool) => ({
      tool,
      constraints: { session: { allowed: [calculatorSession] } },
    })),
  },
};

// Exact argument objects prevent alternate capture/input routes, including optional native flags.
export const calculatorPolicy = `package cua.policy
import rego.v1
default allow := false
args := object.remove(input.arguments, {"_session_id", "_transport_session_id"})
# Driver discovery evaluates policies with empty arguments; targetless mutations still fail validation.
allow if {
  input.tool in {"check_permissions", "launch_app", "get_window_state", "click", "end_session"}
  args == {}
}
allow if {
  input.tool == "check_permissions"
  args == {"session":"${calculatorSession}", "prompt":false, "probe_direct_capture":false}
}
allow if {
  input.tool == "launch_app"
  args == {"session":"${calculatorSession}", "bundle_id":"com.apple.calculator"}
}
allow if {
  input.tool == "get_window_state"
  args == {"session":"${calculatorSession}", "pid":args.pid, "window_id":args.window_id,
    "include_screenshot":false, "include_accessibility_tree":true, "tree_format":"both",
    "max_elements":128, "max_depth":12, "timeout_ms":1000}
  args.pid > 0
  args.window_id > 0
}
allow if {
  input.tool == "click"
  args == {"session":"${calculatorSession}", "target":{"kind":"window", "pid":args.target.pid,
    "window_id":args.target.window_id}, "element_token":args.element_token,
    "button":"left", "delivery_mode":"background"}
  args.target.pid > 0
  args.target.window_id > 0
  count(args.element_token) <= 30
  regex.match("^s[0-9a-f]{8}:[0-9]+$", args.element_token)
}
# The native boundary expands the exact window target before its second policy check.
allow if {
  input.tool == "click"
  args == {"session":"${calculatorSession}", "scope":"window", "pid":args.pid,
    "window_id":args.window_id, "element_token":args.element_token,
    "button":"left", "delivery_mode":"background"}
  args.pid > 0
  args.window_id > 0
  count(args.element_token) <= 30
  regex.match("^s[0-9a-f]{8}:[0-9]+$", args.element_token)
}
allow if {
  input.tool == "end_session"
  args == {"session":"${calculatorSession}"}
}
`;

export interface CalculatorCheck {
  readonly name: string;
  readonly status: "passed" | "pending";
  readonly code?: string;
}

const ObjectResult = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  degraded_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refusal: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
});

export const calculatorRefusal = (result: CallToolResult) => {
  const data = calculatorResult(result);
  assert.equal(result.isError, true, "A denied operation unexpectedly succeeded.");
  const refusal = Schema.decodeUnknownSync(ObjectResult)(data);
  const code = refusal.refusal?.code ?? refusal.code;
  assert(
    code &&
      [
        "permission_denied",
        "bounded_resource_outside_manifest",
        "stale_element_token",
        "session_ended",
        "authorization_suspended",
      ].includes(code),
    "Unexpected driver refusal.",
  );

  return code;
};

const Element = Schema.Struct({
  role: Schema.String,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  value: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  element_token: Schema.optionalKey(Schema.String),
  actions: Schema.optionalKey(Schema.Array(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  subrole: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const Snapshot = Schema.Struct({
  pid: Schema.Int,
  window_id: Schema.Int,
  snapshot_id: Schema.String,
  elements: Schema.Array(Element),
  tree_markdown: Schema.String,
  truncated: Schema.optionalKey(Schema.Boolean),
  degraded_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const calculatorSnapshot = (result: CallToolResult, pid: number, windowId: number) => {
  assert(!result.isError, "Window observation refused.");
  const snapshot = Schema.decodeUnknownSync(Snapshot)(calculatorResult(result));
  assert.equal(snapshot.pid, pid, "Snapshot process changed.");
  assert.equal(snapshot.window_id, windowId, "Snapshot window changed.");
  assert(!snapshot.truncated && !snapshot.degraded_reason, "Incomplete accessibility observation.");
  assert(snapshot.elements.length > 0 && snapshot.elements.length <= 128, "Invalid element count.");

  return snapshot;
};

export const calculatorButton = (snapshot: typeof Snapshot.Type, labels: ReadonlyArray<string>) => {
  const matches = snapshot.elements.filter(
    (element) =>
      element.role === "AXButton" &&
      element.enabled !== false &&
      !element.subrole &&
      element.actions?.includes("AXPress") &&
      labels.some((label) => label.toLowerCase() === element.label?.toLowerCase()),
  );

  assert.equal(matches.length, 1, "Calculator button is missing or ambiguous.");
  const token = matches[0]!.element_token;
  assert(
    token &&
      token.startsWith(`${snapshot.snapshot_id}:`) &&
      token.length <= 30 &&
      !token.includes("\n"),
    "Invalid current element token.",
  );

  return token;
};

export const calculatorDisplay = (snapshot: typeof Snapshot.Type) => {
  // The pinned driver omits read-only static text from its actionable element array.
  const displays = [
    ...snapshot.tree_markdown.matchAll(/^\s*- AXStaticText = "([^"]*)" \(Edit field\)$/gm),
  ];

  assert.equal(displays.length, 1, "Calculator display is missing or ambiguous.");

  return displays[0]![1];
};

export const calculatorDiscovery = (driver: CalculatorDriver) =>
  discoverCalculatorTools(driver, calculatorManifest.allow.tools);

export const runCalculatorTrial = async (
  driver: CalculatorDriver,
  checks: CalculatorCheck[],
  scenario: "normal" | "screen-locked" | "accessibility-denied" = "normal",
  lockedTarget?: { readonly pid: number; readonly windowId: number },
) => {
  const tools = await calculatorDiscovery(driver);

  const validators = new Map(
    tools.map((tool) => [
      tool.name,
      compileSchema(Schema.decodeUnknownSync(Schema.JsonObject)(tool.inputSchema)),
    ]),
  );

  const call = async (name: string, arguments_: Schema.JsonObject) => {
    const args = { ...arguments_, session: calculatorSession };
    assert(validators.get(name)?.(args), "Arguments failed the original driver schema.");
    const result = await driver.call(name, args);
    const output = tools.find((tool) => tool.name === name)?.outputSchema;

    if (!result.isError && output)
      assert(
        compileSchema(Schema.decodeUnknownSync(Schema.JsonObject)(output))(
          result.structuredContent,
        ),
        "Invalid original output schema.",
      );

    return result;
  };

  checks.push({
    name: "MCP handshake and original input/output schema validation",
    status: "passed",
  });

  const permissions = calculatorResult(
    await call("check_permissions", { prompt: false, probe_direct_capture: false }),
  );

  const status = Schema.decodeUnknownSync(
    Schema.Struct({
      accessibility: Schema.Boolean,
      screen_recording: Schema.Boolean,
      source: Schema.Struct({ attribution: Schema.String }),
    }),
  )(permissions);

  assert(status.source.attribution !== "driver-daemon", "Unexpected shared daemon attribution.");
  checks.push({
    name: "direct runtime permission attribution",
    status: "passed",
    code: status.source.attribution,
  });

  if (status.screen_recording)
    checks.push({
      name: "Screen Recording disabled",
      status: "pending",
      code: "existing-host-grant",
    });
  else checks.push({ name: "Screen Recording disabled", status: "passed" });

  if (scenario === "accessibility-denied") {
    assert(!status.accessibility, "Disable Accessibility manually before this scenario.");
    checks.push({ name: "revoked Accessibility detected before input", status: "passed" });

    return { tools, binding: null };
  }

  assert(
    status.accessibility,
    "Accessibility permission is missing; grant it manually to the direct host.",
  );

  if (scenario === "screen-locked") {
    assert(
      lockedTarget &&
        Number.isSafeInteger(lockedTarget.pid) &&
        lockedTarget.pid > 0 &&
        Number.isSafeInteger(lockedTarget.windowId) &&
        lockedTarget.windowId > 0,
      "Pass the prepared Calculator PID and window ID for the locked-screen check.",
    );

    const result = await call("get_window_state", {
      pid: lockedTarget.pid,
      window_id: lockedTarget.windowId,
      include_screenshot: false,
      include_accessibility_tree: true,
      tree_format: "both",
      max_elements: 128,
      max_depth: 12,
      timeout_ms: 1000,
    });

    const data = calculatorResult(result);
    const refusal = Schema.decodeUnknownSync(ObjectResult)(data);
    assert(
      data.degraded_reason === "screen_locked" ||
        refusal.degraded_reason?.startsWith("screen_locked:") ||
        refusal.code === "screen_locked" ||
        refusal.refusal?.code === "screen_locked",
      "Driver did not identify a locked screen.",
    );
    checks.push({
      name: "locked screen refuses useful observation without input",
      status: "passed",
    });

    return { tools, binding: lockedTarget };
  }

  const denied = async (name: string, args: Schema.JsonObject) => {
    let code: string;

    try {
      code = calculatorRefusal(await driver.call(name, args));
    } catch (error) {
      // An SDK protocol rejection is also a refusal before dispatch, not an action success.
      if (error instanceof Error && "code" in error && error.code === -32602)
        code = "protocol-denied";
      else throw error;
    }

    checks.push({ name: `denied ${name}`, status: "passed", code });

    return code;
  };

  await denied("launch_app", { bundle_id: "com.apple.finder", session: calculatorSession });
  await denied("list_windows", { app: "com.apple.calculator", session: calculatorSession });
  await denied("screenshot", { session: calculatorSession });
  await denied("check_permissions", {
    prompt: true,
    probe_direct_capture: true,
    session: calculatorSession,
  });
  await denied("launch_app", {
    bundle_id: "com.apple.calculator",
    urls: ["https://example.invalid"],
    session: calculatorSession,
  });
  await denied("launch_app", { bundle_id: "com.apple.calculator", session: "foreign" });

  for (const name of calculatorManifest.allow.tools) {
    // No targetless call can use the discovery sentinel, including permission prompts or revocation.
    // eslint-disable-next-line no-await-in-loop
    await denied(name, {});
  }

  const launch = await call("launch_app", { bundle_id: "com.apple.calculator" });
  assert(!launch.isError, "Calculator-only setup refused.");

  const binding = Schema.decodeUnknownSync(
    Schema.Struct({
      pid: Schema.Int,
      bundle_id: Schema.String,
      windows: Schema.Array(
        Schema.Struct({
          window_id: Schema.Int,
          pid: Schema.Int,
          is_on_screen: Schema.Boolean,
          on_current_space: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
        }),
      ),
    }),
  )(calculatorResult(launch));

  assert.equal(binding.bundle_id, "com.apple.calculator", "Unexpected app identity.");

  const windows = binding.windows.filter(
    (window) =>
      window.pid === binding.pid && window.is_on_screen && window.on_current_space === true,
  );

  assert.equal(windows.length, 1, "Prepare exactly one Calculator window on the current Space.");
  const windowId = windows[0]!.window_id;

  const snapshotArgs = {
    pid: binding.pid,
    window_id: windowId,
    include_screenshot: false,
    include_accessibility_tree: true,
    tree_format: "both",
    max_elements: 128,
    max_depth: 12,
    timeout_ms: 1000,
  };

  const read = async () =>
    calculatorSnapshot(await call("get_window_state", snapshotArgs), binding.pid, windowId);

  await denied("get_window_state", {
    ...snapshotArgs,
    pid: process.pid,
    session: calculatorSession,
  });
  let snapshot = await read();
  checks.push({ name: "Calculator binding and screenshot-free AX observation", status: "passed" });

  const pressArgs = (token: string): Schema.JsonObject => ({
    target: { kind: "window", pid: binding.pid, window_id: windowId },
    element_token: token,
    button: "left",
    delivery_mode: "background",
    session: calculatorSession,
  });

  const stale = calculatorButton(snapshot, ["1", "one"]);
  snapshot = await read();
  assert.equal(
    await denied("click", pressArgs(stale)),
    "stale_element_token",
    "Unexpected stale-token refusal.",
  );
  const token = calculatorButton(snapshot, ["1", "one"]);
  await denied("click", { ...pressArgs(token), x: 1, y: 1 });
  await denied("click", { ...pressArgs(token), delivery_mode: "foreground" });
  await denied("click", { ...pressArgs(token), button: "middle" });
  await denied("get_window_state", {
    ...snapshotArgs,
    include_screenshot: true,
    session: calculatorSession,
  });
  await denied("get_window_state", {
    ...snapshotArgs,
    screenshot_out_file: "/tmp/denied.png",
    session: calculatorSession,
  });

  for (const labels of [
    ["AC", "C", "Clear", "All Clear"],
    ["1", "one"],
    ["2", "two"],
    ["+", "Add", "plus"],
    ["7", "seven"],
    ["=", "Equals", "equals"],
  ]) {
    const current = calculatorButton(snapshot, labels);
    // No action is retried: a lost response ends the probe with uncertain effects.
    // eslint-disable-next-line no-await-in-loop
    const result = await call("click", pressArgs(current));
    assert(!result.isError, "AX button press refused; no retry was attempted.");
    const action = calculatorResult(result);
    assert.notEqual(action.effect, "refused", "AX press reported refusal; no retry was attempted.");
    assert.equal(action.route, "accessibility", "Driver escalated outside the AX route.");
    // eslint-disable-next-line no-await-in-loop
    snapshot = await read();
  }

  assert.equal(calculatorDisplay(snapshot), "19", "Calculator did not independently report 19.");
  checks.push({
    name: "six AX-only presses and independent display readback of 19",
    status: "passed",
  });
  const ended = await call("end_session", {});
  assert(!ended.isError && calculatorResult(ended).active === false, "Session revocation failed.");
  assert.equal(
    await denied("get_window_state", { ...snapshotArgs, session: calculatorSession }),
    "session_ended",
    "Unexpected revocation refusal.",
  );
  checks.push({ name: "session revocation rejects further observation/input", status: "passed" });

  return { tools, binding: { pid: binding.pid, windowId } };
};
