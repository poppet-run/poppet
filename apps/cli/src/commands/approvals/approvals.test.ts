import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, ChatSettings, defaultPolicy, SkillsLive } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { MCP } from "@poppet/mcp";
import { LocalMemoryLive } from "@poppet/memory";
import { Store, StoreLive } from "@poppet/store";
import { WorkerRequests } from "@poppet/worker";
import { Clock, Effect, Layer, Stream } from "effect";

import { manageApprovals } from "#src/commands/approvals/approvals";
import { WorkerRequestsLive } from "#src/commands/worker/requests";

describe("manageApprovals", () => {
  test("lists pending approvals with summaries and conversations, and approves or denies through the worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-cli-approvals-"));

    const config = Layer.succeed(AppConfig, {
      applicationName: "Test",
      dataDirectory: directory,
      provider: "test-provider",
      model: "test-model",
    });

    const storeLayer = StoreLive.pipe(Layer.provideMerge(config));

    const requestsLayer = WorkerRequestsLive.pipe(
      Layer.provide([
        config,
        storeLayer,
        LocalMemoryLive.pipe(Layer.provide(storeLayer)),
        SkillsLive.pipe(Layer.provide(config)),
        Layer.succeed(ChatSettings, defaultPolicy),
        Layer.succeed(MCP, {
          status: Effect.succeed([]),
          snapshot: () => Effect.succeed([]),
          tools: () => Effect.succeed([]),
        }),
        Layer.succeed(Agent, {
          resume: () => Stream.die("Unexpected resume"),
          send: () => Stream.die("Unexpected send"),
          nameSession: () => Effect.void,
        }),
      ]),
    );

    const layer = Layer.mergeAll(storeLayer, requestsLayer);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* Store;
            const requests = yield* WorkerRequests;
            const now = yield* Clock.currentTimeMillis;

            const s1 = yield* store.createSession("test-provider", "test-model");
            const r1 = yield* store.queueRun(s1.id, [{ role: "user", text: "Restart" }]);
            yield* store.startRun(r1.id);
            yield* store.recordToolCalls(
              r1.id,
              {
                output: [
                  {
                    type: "tool-call",
                    callId: "bash-1",
                    namespace: "poppet_system",
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "systemctl restart app",
                      cwd: "/tmp",
                      timeoutSeconds: 10,
                    }),
                  },
                ],
                continuation: {
                  version: 1,
                  provider: "test-provider",
                  model: "test-model",
                  data: {},
                },
                finishReason: "tool-calls",
                usage: null,
              },
              [{ callId: "bash-1", reviewed: true }],
            );
            yield* store.recordToolReview(r1.id, "bash-1", {
              decision: "needs_approval",
              reason: "Restart app",
            });

            const bashApproval = yield* store.parkRun(r1.id, "bash-1", {
              kind: "bash",
              request: {
                kind: "bash",
                command: "systemctl restart app",
                cwd: "/tmp",
                timeoutSeconds: 10,
                reason: "Restart app",
              },
              requester: {
                surface: "gateway",
                adapter: "discord",
                conversationId: "thread-1",
              },
              expiresAt: now + 60_000,
            });

            const s2 = yield* store.createSession("test-provider", "test-model");
            const r2 = yield* store.queueRun(s2.id, [{ role: "user", text: "Deploy" }]);
            yield* store.startRun(r2.id);
            yield* store.recordToolCalls(
              r2.id,
              {
                output: [
                  {
                    type: "tool-call",
                    callId: "mcp-1",
                    namespace: "poppet_mcp",
                    name: "deploy_app",
                    arguments: JSON.stringify({ target: "prod" }),
                  },
                ],
                continuation: {
                  version: 1,
                  provider: "test-provider",
                  model: "test-model",
                  data: {},
                },
                finishReason: "tool-calls",
                usage: null,
              },
              [{ callId: "mcp-1", serverId: "ops", toolName: "deploy_app", reviewed: true }],
            );
            yield* store.recordToolReview(r2.id, "mcp-1", {
              decision: "needs_approval",
              reason: "Deploy production",
              target: "prod",
              effects: "Restarts production",
            });

            const mcpApproval = yield* store.parkRun(r2.id, "mcp-1", {
              kind: "mcp",
              request: {
                kind: "mcp",
                invocation: "{}",
                target: "prod",
                effects: "Restarts production",
                reason: "Deploy production",
              },
              requester: {
                surface: "scheduled",
                adapter: "slack",
                conversationId: "C123",
              },
              expiresAt: now + 120_000,
            });

            const listed = yield* manageApprovals({ action: "list" });

            expect(listed).toEqual([
              {
                id: bashApproval.id,
                runId: r1.id,
                kind: "bash",
                summary: "systemctl restart app",
                conversation: "discord:thread-1",
                createdAt: bashApproval.createdAt,
                expiresAt: bashApproval.expiresAt,
              },
              {
                id: mcpApproval.id,
                runId: r2.id,
                kind: "mcp",
                summary: "prod: Restarts production",
                conversation: "slack:C123",
                createdAt: mcpApproval.createdAt,
                expiresAt: mcpApproval.expiresAt,
              },
            ]);

            // Approve the first through the worker /v1/queries endpoint.
            const approveResponse = yield* requests.handle(
              new Request("http://localhost/v1/queries", { method: "POST" }),
              { kind: "approvals", command: { action: "approve", id: bashApproval.id } },
            );

            expect(approveResponse.status).toBe(200);
            expect(yield* Effect.promise(() => approveResponse.json())).toEqual({
              ok: true,
              value: {
                id: bashApproval.id,
                runId: r1.id,
                kind: "bash",
                state: "approved",
              },
            });

            // Re-answering an already decided approval fails cleanly.
            const duplicate = yield* Effect.flip(
              manageApprovals({ action: "approve", id: bashApproval.id }),
            );

            expect(duplicate.message).toContain("already ended (approved)");

            // Deny the second.
            expect(yield* manageApprovals({ action: "deny", id: mcpApproval.id })).toEqual({
              id: mcpApproval.id,
              runId: r2.id,
              kind: "mcp",
              state: "denied",
            });

            expect(yield* manageApprovals({ action: "list" })).toEqual([]);

            // Unknown ID fails cleanly.
            const missing = yield* Effect.flip(
              manageApprovals({
                action: "approve",
                id: "00000000-0000-4000-8000-000000000000",
              }),
            );

            expect(missing.message).toBe("No matching pending approval.");
          }),
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
