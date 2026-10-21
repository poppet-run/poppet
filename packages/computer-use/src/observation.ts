import { Schema } from "effect";

import { computerFailure } from "#src/errors";
import type { CalculatorTarget } from "#src/target";

const Element = Schema.Struct({
  element_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  role: Schema.String,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  value: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  actions: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

const State = Schema.Struct({
  pid: Schema.Int,
  window_id: Schema.Int,
  snapshot_id: Schema.String.check(Schema.isPattern(/^s[0-9a-f]{8}$/)),
  app_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  window_title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  elements: Schema.Array(Element).check(Schema.isMaxLength(128)),
  tree_markdown: Schema.String,
  truncated: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  elements_complete: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  degraded: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  degraded_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const computerObservation = (
  data: Schema.JsonObject,
  target: CalculatorTarget,
  snapshotId: string,
  limit: number,
) => {
  const state = Schema.decodeUnknownSync(State)(data);

  if (state.pid !== target.pid || state.window_id !== target.windowId)
    throw computerFailure(
      "tool-uncertain",
      "Calculator process/window identity changed. Start a new trial; no retargeting was attempted.",
    );

  if (state.app_name !== "Calculator" || state.degraded || state.degraded_reason)
    throw computerFailure(
      "tool-reported",
      "Calculator observation is unavailable or degraded. Check the window, permissions, and screen lock.",
    );
  const indices = new Set(state.elements.map((element) => element.element_index));

  if (indices.size !== state.elements.length || state.elements.length === 0)
    throw computerFailure("tool-uncertain", "Calculator returned an invalid element set.");

  // Cua 0.38.0 hardcodes false: its AX walker cannot prove a complete projection.
  if (state.elements_complete === true)
    throw computerFailure(
      "tool-uncertain",
      "The pinned Calculator driver made an unsupported completeness claim. No references were issued.",
    );
  let truncated = state.truncated === true;

  const text = (value: string | null | undefined, maximum = 2048) => {
    if (value == null) return null;

    if (value.length <= maximum) return value;
    truncated = true;

    return value.slice(0, maximum).replace(/[\uD800-\uDBFF]$/, "");
  };

  // The pinned driver projects only actionable elements; these read-only display fields are inline.
  const displays = [
    ...state.tree_markdown.matchAll(
      /^\s*- AXStaticText = ("(?:\\.|[^"\\])*") \((Edit field|Last Expression)\)$/gm,
    ),
  ].map((match) => ({
    role: "AXStaticText",
    label: match[2]!,
    value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(match[1]),
    enabled: null,
    actions: [],
  }));

  if (displays.filter((element) => element.label === "Edit field").length !== 1)
    throw computerFailure(
      "tool-reported",
      "Calculator's display is missing or ambiguous. Use an English basic-mode Calculator window.",
    );

  const elements = [...displays, ...state.elements].slice(0, 128).map((element) => ({
    reference: null,
    role: text(element.role, 64),
    label: text(element.label),
    value: text(element.value),
    enabled: element.enabled ?? null,
    actions: (element.actions ?? []).slice(0, 16).map((action) => text(action, 64)),
  }));

  if (
    state.elements.length + displays.length > 128 ||
    state.elements.some((element) => (element.actions?.length ?? 0) > 16)
  )
    truncated = true;
  const app = { bundleId: "com.apple.calculator", name: "Calculator", pid: target.pid };
  const window = { id: target.windowId, title: text(state.window_title, 256) };

  const serialize = (count: number) => {
    return JSON.stringify({
      snapshotId,
      app,
      window,
      elements: elements.slice(0, count),
      truncated,
      completeness: truncated ? "incomplete" : "unknown",
    });
  };

  const complete = serialize(elements.length);

  if (Buffer.byteLength(complete) <= limit) return complete;
  truncated = true;

  if (Buffer.byteLength(serialize(0)) > limit)
    throw computerFailure(
      "tool-limit",
      "Computer observation metadata exceeds the tool-result budget.",
    );
  let low = 0;
  let high = elements.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (Buffer.byteLength(serialize(middle)) <= limit) low = middle;
    else high = middle - 1;
  }

  return serialize(low);
};
