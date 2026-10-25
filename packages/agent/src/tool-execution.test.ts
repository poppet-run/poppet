import { StoreError } from "@poppet/store";
import { describe, expect, test } from "vitest";

import { builtinFailures } from "#src/agent-tool";
import { bashFailures } from "#src/bash";
import { AgentError } from "#src/errors";
import { externalFailures } from "#src/external-tools";
import { memoryFailures } from "#src/memory-tools";
import { taskFailures } from "#src/task-tools";
import { toolFailureKind } from "#src/tool-execution";

const policies = {
  read_session: builtinFailures,
  fetch_page: builtinFailures,
  search_web: builtinFailures,
  memory: memoryFailures,
  manage_tasks: taskFailures,
  bash: bashFailures,
  external: externalFailures,
};

const agentFailure = (reason: AgentError["reason"]) => new AgentError({ reason, message: reason });

const storeFailure = (reason: StoreError["reason"]) => new StoreError({ reason, message: reason });

describe("toolFailureKind", () => {
  test.each([
    ["read_session", agentFailure("tool-storage"), "reported"],
    ["fetch_page", agentFailure("tool-network"), "reported"],
    ["search_web", agentFailure("tool-rate-limit"), "reported"],
    ["read_session", agentFailure("budget"), "fatal"],
    ["read_session", storeFailure("storage"), "fatal"],
    ["memory", agentFailure("memory-limit"), "reported"],
    ["memory", agentFailure("memory-storage"), "uncertain"],
    ["manage_tasks", storeFailure("conflict"), "reported"],
    ["manage_tasks", storeFailure("invalid-request"), "reported"],
    ["manage_tasks", storeFailure("storage"), "uncertain"],
    ["manage_tasks", storeFailure("corrupt"), "fatal"],
    ["manage_tasks", agentFailure("tool-permission"), "reported"],
    ["external", agentFailure("tool-reported"), "reported"],
    ["external", agentFailure("tool-network"), "uncertain"],
    ["external", agentFailure("tool-uncertain"), "uncertain"],
    ["bash", agentFailure("tool-uncertain"), "uncertain"],
    ["bash", agentFailure("command-denied"), "fatal"],
    ["bash", storeFailure("storage"), "fatal"],
  ] as const)("when %s fails with %o, classifies it as %s", (name, error, kind) => {
    expect(toolFailureKind(policies[name], error)).toBe(kind);
  });
});
