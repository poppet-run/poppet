import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { renderWorkerStatus, WorkerStatusReport } from "#src/commands/worker/format";

describe("renderWorkerStatus", () => {
  test("when a connected channel reports a null error, renders the status", () => {
    const report = Schema.decodeUnknownSync(WorkerStatusReport)({
      service: { installed: true, active: true, file: "worker.plist", log: "worker.log" },
      worker: {
        running: true,
        pid: 44065,
        startedAt: 1794223726871,
        activeOccurrence: null,
        taskCount: 0,
        pausedTaskCount: 0,
        pendingCount: 0,
        nextScheduledAt: null,
        providerPauses: [],
        recent: [],
        connections: [],
        messaging: {
          running: true,
          enabled: true,
          channels: [
            {
              adapter: "discord",
              connected: true,
              error: null,
              id: "discord",
              name: "Discord",
              enabled: true,
              lastError: null,
            },
          ],
        },
      },
    });

    expect(renderWorkerStatus(report)).toContain("Discord");
  });
});
