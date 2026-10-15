import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { workerLaunch } from "#src/worker";

test("builds an absolute CLI launch description without including shell credentials", () => {
  const previous = process.env.POPPET_OPENROUTER_API_KEY;
  process.env.POPPET_OPENROUTER_API_KEY = "must-not-be-written";

  try {
    const launch = workerLaunch({
      applicationName: "Test",
      dataDirectory: "/tmp/data",
      notesDirectory: "/tmp/notes",
      provider: "openrouter",
      model: "selected-model",
    });

    expect(launch.executable).toBe(process.execPath);
    expect(launch.arguments).toEqual([
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "worker",
      "run",
    ]);
    expect(launch.workingDirectory).toBe(process.cwd());
    expect(launch.environment.get("POPPET_MODEL")).toBe("selected-model");
    expect(launch.environment.get("POPPET_DATA_DIR")).toBe("/tmp/data");
    expect(launch.environment.has("POPPET_OPENROUTER_API_KEY")).toBe(false);
    expect(JSON.stringify(Array.from(launch.environment))).not.toContain("must-not-be-written");
  } finally {
    if (previous === undefined) delete process.env.POPPET_OPENROUTER_API_KEY;
    else process.env.POPPET_OPENROUTER_API_KEY = previous;
  }
});
