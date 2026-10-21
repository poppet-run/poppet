import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  calculatorDisplay,
  calculatorSnapshot,
  openCalculatorDriver,
  runCalculatorTrial,
  type CalculatorCheck,
} from "#src/test/calculator-runtime";

const fixture = async (mode = "normal") => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-calculator-runtime-"));

  const driver = await openCalculatorDriver(
    process.execPath,
    [fileURLToPath(new URL("./test/calculator-fixture.ts", import.meta.url)), directory, mode],
    directory,
    new AbortController().signal,
  );

  return {
    directory,
    driver,
    presses: async () =>
      (await Bun.file(`${directory}/presses`).exists())
        ? (await readFile(`${directory}/presses`, "utf8")).trim().split("\n").length
        : 0,
    close: async () => {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("the full trial uses fresh window tokens for six fixed presses and independent readback", async () => {
  const state = await fixture();
  const checks: CalculatorCheck[] = [];

  try {
    expect((await runCalculatorTrial(state.driver, checks)).binding).toEqual({
      pid: 100,
      windowId: 200,
    });
    expect(await state.presses()).toBe(6);
    expect(checks.every((check) => check.status === "passed")).toBe(true);
    expect(checks.some((check) => check.name.includes("independent display"))).toBe(true);

    const events = (await readFile(`${state.directory}/events`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const presses = events.filter(
      (event) =>
        event.name === "click" &&
        event.args.element_token &&
        event.args.x === undefined &&
        event.args.delivery_mode === "background" &&
        event.args.button === "left",
    );

    // One stale-token negative precedes the fixed successful sequence.
    expect(presses.slice(1).map((event) => event.args.element_token)).toEqual(
      Array.from({ length: 6 }, (_, i) => `s${(i + 2).toString(16).padStart(8, "0")}:${i}`),
    );
  } finally {
    await state.close();
  }
});

test.each([
  ["unexpected-tool", "Unexpected discovered tool", 0],
  ["wrong-window", "Snapshot window changed", 0],
  ["unknown-space", "exactly one Calculator window", 0],
  ["wrong-stale-code", "Unexpected stale-token refusal", 0],
  ["pixel-route", "outside the AX route", 1],
  ["invalid-output", "Invalid original output schema", 1],
  ["media", "Unexpected driver media", 1],
  ["refused-effect", "AX press reported refusal", 1],
  ["wrong-display", "independently report 19", 6],
  ["wrong-revocation-code", "Unexpected revocation refusal", 6],
] as const)("the trial stops on %s without continuing input", async (mode, message, presses) => {
  const state = await fixture(mode);

  try {
    await expect(runCalculatorTrial(state.driver, [])).rejects.toThrow(message);
    expect(await state.presses()).toBe(presses);
  } finally {
    await state.close();
  }
});

test.each(["disconnect", "hang"])(
  "an uncertain %s response reaps the driver and cannot replay input",
  async (mode) => {
    const state = await fixture(mode);

    try {
      await expect(runCalculatorTrial(state.driver, [])).rejects.toThrow();
      expect(await state.presses()).toBe(1);
      expect(state.driver.calls.at(-1)?.outcome).toBe("uncertain");
      await expect(state.driver.call("click", {})).rejects.toThrow("Driver stopped");
      expect(() => process.kill(state.driver.pid, 0)).toThrow();
    } finally {
      await state.close();
    }
  },
  20000,
);

test.each(["screen-locked", "accessibility-denied"] as const)(
  "the %s scenario performs no input",
  async (scenario) => {
    const state = await fixture(scenario);

    try {
      await runCalculatorTrial(state.driver, [], scenario, { pid: 100, windowId: 200 });
      expect(await state.presses()).toBe(0);
      expect(state.driver.calls.some((call) => ["launch_app", "click"].includes(call.tool))).toBe(
        false,
      );
    } finally {
      await state.close();
    }
  },
);

test("display readback uses exactly one static edit field and rejects incomplete snapshots", () => {
  const result = {
    content: [],
    structuredContent: {
      pid: 1,
      window_id: 2,
      snapshot_id: "s0123abcd",
      elements: [{ role: "AXWindow" }],
      tree_markdown: '- [19] AXButton "19"\n- AXStaticText = "0" (Edit field)',
    },
  };

  const snapshot = calculatorSnapshot(result, 1, 2);
  expect(calculatorDisplay(snapshot)).toBe("0");
  expect(() => calculatorDisplay({ ...snapshot, tree_markdown: "19" })).toThrow(
    "missing or ambiguous",
  );
  expect(() =>
    calculatorDisplay({
      ...snapshot,
      tree_markdown: `${snapshot.tree_markdown}\n${snapshot.tree_markdown}`,
    }),
  ).toThrow("missing or ambiguous");
  expect(() =>
    calculatorSnapshot(
      { ...result, structuredContent: { ...result.structuredContent, truncated: true } },
      1,
      2,
    ),
  ).toThrow("Incomplete");
  expect(() =>
    calculatorSnapshot(
      { ...result, structuredContent: { ...result.structuredContent, capture_id: "forbidden" } },
      1,
      2,
    ),
  ).toThrow("Unexpected capture");
});
