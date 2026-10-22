import { expect, test } from "bun:test";

import { Agent, Commands, Approvals } from "@poppet/agent";
import { Store, StoreDatabase, ApprovalRepository } from "@poppet/store";
import { Effect, Stream } from "effect";

import { makeTaskStore } from "#src/task-store";

import { fixture } from "../../agent/src/test/commands-fixture";

test("scheduled capability permits only a fixed proposal, even when an interactive read rule would allow execution", async () => {
  const f = await fixture();

  try {
    f.state.executable = "/usr/bin/uname";
    f.state.args = ["-s"];
    f.state.automaticReads = true;
    await f.run(
      Effect.gen(function* () {
        const commands = yield* Commands;
        const { database } = yield* StoreDatabase;
        const tasks = makeTaskStore(database);

        const payload = yield* commands.template(
          { executable: f.state.executable, args: f.state.args, cwd: "." },
          f.root,
          null,
        );

        const task = tasks.add(
          {
            name: "Review",
            prompt: "Propose saved command",
            provider: "test",
            model: "model",
            workload: "assistant",
            schedule: { type: "once", at: Date.now() },
          },
          Date.now(),
          null,
          null,
          undefined,
          false,
          null,
          null,
          payload,
        );

        tasks.reconcile(Date.now());
        const occurrence = tasks.occurrences(task.id)[0]!;
        const store = yield* Store;
        const session = yield* store.createSession("test", "model");
        yield* Stream.runForEach(
          (yield* Agent).send(session.id, "Propose saved command", { readOnlyTools: true }),
          (event) =>
            Effect.sync(() => {
              if (event.type === "started")
                database
                  .query(
                    "UPDATE job_occurrences SET status = 'running', session_id = ?, run_id = ? WHERE id = ?",
                  )
                  .run(session.id, event.run.id, occurrence.id);
            }),
        );
        const proposal = (yield* ApprovalRepository).list(Date.now())[0]!;
        expect(proposal.state).toBe("pending");
        expect(f.state.executions).toBe(0);
        database
          .query("UPDATE job_occurrences SET status = 'completed', finished_at = ? WHERE id = ?")
          .run(Date.now(), occurrence.id);
        tasks.clear();
        expect(
          JSON.parse(yield* (yield* Approvals).command({ action: "approve", id: proposal.id }))
            .state,
        ).toBe("cancelled");
      }),
    );
  } finally {
    await f.close();
  }
});
