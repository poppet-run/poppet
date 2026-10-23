import { describe, expect, test } from "bun:test";

import { StoreError } from "@poppet/store";

import { AgentError } from "#src/errors";
import { toolFailureKind } from "#src/tool-execution";

const agentFailure = (reason: AgentError["reason"]) => new AgentError({ reason, message: reason });

const storeFailure = (reason: StoreError["reason"]) => new StoreError({ reason, message: reason });

describe("toolFailureKind", () => {
  test.each([
    ["read_note", agentFailure("tool-storage"), "reported"],
    ["fetch_page", agentFailure("tool-network"), "reported"],
    ["search_web", agentFailure("tool-rate-limit"), "reported"],
    ["read_note", agentFailure("budget"), "fatal"],
    ["read_note", storeFailure("storage"), "fatal"],
    ["save_note", agentFailure("tool-permission"), "reported"],
    ["save_note", agentFailure("tool-limit"), "reported"],
    ["save_note", agentFailure("tool-storage"), "uncertain"],
    ["memory", agentFailure("memory-limit"), "reported"],
    ["memory", agentFailure("memory-storage"), "uncertain"],
    ["manage_skill", agentFailure("tool-arguments"), "reported"],
    ["manage_skill", agentFailure("tool-limit"), "reported"],
    ["manage_skill", agentFailure("skill-storage"), "uncertain"],
    ["manage_tasks", storeFailure("conflict"), "reported"],
    ["manage_tasks", storeFailure("invalid-request"), "reported"],
    ["manage_tasks", storeFailure("storage"), "uncertain"],
    ["manage_tasks", storeFailure("corrupt"), "fatal"],
    ["manage_tasks", agentFailure("tool-permission"), "reported"],
    ["external", agentFailure("tool-reported"), "reported"],
    ["external", agentFailure("tool-network"), "uncertain"],
    ["external", agentFailure("tool-uncertain"), "uncertain"],
  ] as const)("when %s fails with %o, classifies it as %s", (name, error, kind) => {
    expect(toolFailureKind(name, error)).toBe(kind);
  });
});
