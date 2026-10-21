import type { CalculatorTarget } from "#src/target";

export const computerSession = "poppet-calculator-observation";

export const computerManifest = {
  version: 3,
  expires_after: "5m",
  idle_timeout: "5m",
  allow: { tools: ["check_permissions", "get_window_state", "end_session"] },
  resources: {
    apps: [{ bundle_id: "com.apple.calculator", launch: false, windows: "all" }],
    desktop: { display: false },
  },
};

export const computerGuard = {
  allow: {
    rules: computerManifest.allow.tools.map((tool) => ({
      tool,
      constraints: { session: { allowed: [computerSession] } },
    })),
  },
};

export const computerSnapshotArguments = (target: CalculatorTarget) => ({
  pid: target.pid,
  window_id: target.windowId,
  session: computerSession,
  include_screenshot: false,
  include_accessibility_tree: true,
  tree_format: "both",
  max_elements: 128,
  max_depth: 12,
  timeout_ms: 1000,
});

export const computerPolicy = (target: CalculatorTarget) => `package cua.policy
import rego.v1
default allow := false
args := object.remove(input.arguments, {"_session_id", "_transport_session_id"})
# Empty arguments permit discovery; the managed session constraint denies actual empty calls.
allow if {
  input.tool in {"check_permissions", "get_window_state", "end_session"}
  args == {}
}
allow if {
  input.tool == "check_permissions"
  args == {"session":"${computerSession}", "prompt":false, "probe_direct_capture":false}
}
allow if {
  input.tool == "get_window_state"
  args == ${JSON.stringify(computerSnapshotArguments(target))}
}
allow if {
  input.tool == "end_session"
  args == {"session":"${computerSession}"}
}
`;
