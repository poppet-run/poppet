import { expect, test } from "bun:test";
import { symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ApprovalRepository, Store, StoreDatabase, makeApprovalStore } from "@poppet/store";
import { Effect, Fiber, Schema, Stream } from "effect";

import { Approvals } from "#src/approvals";
import { Commands, commandJSON } from "#src/commands";
import { Agent } from "#src/service";
import { fixture, propose } from "#src/test/commands-fixture";

test("commands require a fresh local grant; proposal review executes exact argv once without inference", async () => {
  const f = await fixture();

  try {
    await f.run(
      Effect.gen(function* () {
        const { session, proposal } = yield* propose(f.root);
        expect(proposal.payload.type).toBe("execute_command");
        expect(proposal.state).toBe("pending");
        expect(f.state.executions).toBe(0);
        const requests = f.state.requests.length;
        const approvals = yield* Approvals;

        const results = yield* Effect.all(
          [
            approvals.command({ action: "approve", id: proposal.id }),
            approvals.command({ action: "approve", id: proposal.id }),
          ],
          { concurrency: "unbounded" },
        );

        expect(results.map((text) => JSON.parse(text).state)).toContain("completed");
        expect(f.state.executions).toBe(1);
        const saved = (yield* ApprovalRepository).show(proposal.id, Date.now());
        expect(saved.receipt?.authority).toBe("owner");
        const output = JSON.parse(String(saved.receipt?.stdout));
        expect(output.args).toEqual(["", "a b", "$(touch nowhere)"]);
        expect(output.cwd).toBe(f.root);
        expect(output.env.POPPET_COMMANDS).toBeUndefined();
        expect(f.state.requests).toHaveLength(requests);
        yield* approvals.command({ action: "approve", id: proposal.id });
        expect(f.state.executions).toBe(1);
        const receipt = yield* (yield* Commands).receipt(proposal.id, null);
        expect(receipt).toContain("untrusted");
        yield* Stream.runDrain((yield* Agent).send(session.id, "Run again")).pipe(Effect.flip);
        expect(
          f.state.requests.at(-1)!.tools.some((tool) => tool.namespace === "poppet_commands"),
        ).toBe(false);
        expect(f.state.executions).toBe(1);
      }),
    );
  } finally {
    await f.close();
  }
});

test("disabled, scheduled and messaging-derived requests cannot grant execution", async () => {
  const f = await fixture();

  try {
    f.state.enabled = false;
    await f.run(propose(f.root).pipe(Effect.flip));
    expect(f.state.requests).toHaveLength(0);
    f.state.enabled = true;
    await f.run(
      Effect.gen(function* () {
        const session = yield* (yield* Store).createSession("test", "model");
        yield* Stream.runDrain(
          (yield* Agent).send(session.id, "Request", { commandsRoot: f.root, readOnlyTools: true }),
        ).pipe(Effect.flip);
        yield* Stream.runDrain(
          (yield* Agent).send(session.id, "Request", {
            commandsRoot: f.root,
            taskDestination: Effect.die("Must not inspect messaging destination"),
          }),
        ).pipe(Effect.flip);
        expect((yield* ApprovalRepository).list(Date.now())).toHaveLength(0);
      }),
    );
    expect(f.state.executions).toBe(0);
  } finally {
    await f.close();
  }
});

test("cwd links, inline evaluation, malformed argv, and complete-preview overflow are denied before dispatch", async () => {
  const f = await fixture();

  try {
    await symlink(f.directory, join(f.root, "escape"));

    for (const input of [
      { executable: f.alias, args: [], cwd: "escape" },
      { executable: f.alias, args: ["--eval", "arbitrary code"], cwd: "." },
      { executable: f.alias, args: ["bad\0arg"], cwd: "." },
      { executable: f.alias, args: Array(129).fill(""), cwd: "." },
    ]) {
      // Each case owns the same temporary store, so open them sequentially.
      // eslint-disable-next-line no-await-in-loop
      await f.run(yieldCommandsTemplate(input, f.root).pipe(Effect.flip));
    }

    f.state.args = ["x".repeat(16000)];
    await f.run(propose(f.root).pipe(Effect.flip));
    await f.run(
      Effect.gen(function* () {
        expect((yield* ApprovalRepository).list(Date.now())).toHaveLength(0);
      }),
    );
    expect(f.state.executions).toBe(0);
  } finally {
    await f.close();
  }
});

const yieldCommandsTemplate = (
  input: { executable: string; args: string[]; cwd: string },
  root: string,
) => Commands.use((service) => service.template(input, root, null));

test("command provenance rejects a different payload and receipts stay owner/project scoped", async () => {
  const f = await fixture();

  try {
    await f.run(
      Effect.gen(function* () {
        const { proposal } = yield* propose(f.root);
        const { database } = yield* StoreDatabase;
        const repo = yield* ApprovalRepository;
        expect(() =>
          makeApprovalStore(database, "different-owner").show(proposal.id, Date.now()),
        ).toThrow("does not exist");
        yield* (yield* Approvals).command({ action: "approve", id: proposal.id });
        yield* (yield* Commands).receipt(proposal.id, "unrelated-project").pipe(Effect.flip);
        const store = yield* Store;
        const session = yield* store.createSession("test", "model");
        const run = yield* store.queueRun(session.id, [{ role: "user", text: "Review" }]);
        yield* store.startRun(run.id);
        const request = { executable: f.alias, args: ["--version"], cwd: "." };
        yield* (yield* Commands).grant(run.id, f.root);
        yield* store.recordToolCalls(run.id, {
          output: [
            {
              type: "tool-call",
              namespace: "poppet_commands",
              name: "request_command",
              callId: "source-check",
              arguments: JSON.stringify(request),
            },
          ],
          continuation: { version: 1, provider: "test", model: "model", data: {} },
          finishReason: "tool-calls",
          usage: null,
        });
        yield* store.startToolCall(run.id, "source-check");

        const different = yield* (yield* Commands).template(
          { ...request, args: ["test"] },
          f.root,
          null,
        );

        expect(() => repo.create(different, run.id, "source-check", Date.now())).toThrow(
          "does not match",
        );
        yield* store.finishRun(run.id, { status: "failed", reason: "fixture-ended" });
      }),
    );
  } finally {
    await f.close();
  }
});

test("receipt failure after a real dispatch becomes uncertain on restart without another dispatch", async () => {
  const f = await fixture();

  try {
    const id = await f.run(
      Effect.gen(function* () {
        const { proposal } = yield* propose(f.root);
        const { database } = yield* StoreDatabase;
        database.run(
          "CREATE TRIGGER reject_command_receipt BEFORE UPDATE ON action_proposals WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END",
        );
        yield* (yield* Approvals).command({ action: "approve", id: proposal.id }).pipe(Effect.flip);
        expect((yield* ApprovalRepository).show(proposal.id, Date.now()).state).toBe("executing");

        return proposal.id;
      }),
    );

    await f.run(
      Effect.gen(function* () {
        const recovered = JSON.parse(yield* (yield* Approvals).command({ action: "approve", id }));
        expect(recovered.state).toBe("uncertain");
        expect(recovered.receipt.authority).toBe("owner");
      }),
    );
    expect(f.state.executions).toBe(1);
  } finally {
    await f.close();
  }
});

test("owner review JSON preserves control and supplementary characters without emitting terminal controls", () => {
  const value = { argv: ["\u001b[31m", "\u009b31m", "\u202e", "\u{e0001}", "λ"] };
  const text = commandJSON(value, true);
  expect(JSON.parse(text)).toEqual(value);

  for (const character of [0x1b, 0x9b, 0x202e, 0xe0001])
    expect(text.includes(String.fromCodePoint(character))).toBe(false);
});

test("cancelled, expired and replaced executable proposals cannot dispatch", async () => {
  const f = await fixture();

  try {
    await f.run(
      Effect.gen(function* () {
        const approvals = yield* Approvals;
        const repo = yield* ApprovalRepository;
        const first = (yield* propose(f.root)).proposal;
        yield* approvals.command({ action: "cancel", id: first.id });
        expect(
          JSON.parse(yield* approvals.command({ action: "approve", id: first.id })).state,
        ).toBe("cancelled");
        const second = (yield* propose(f.root)).proposal;
        repo.show(second.id, second.expiresAt);
        expect(
          JSON.parse(yield* approvals.command({ action: "approve", id: second.id })).state,
        ).toBe("expired");
        const third = (yield* propose(f.root)).proposal;
        yield* Effect.promise(async () => {
          await unlink(f.alias);
          await symlink("/usr/bin/true", f.alias);
        });
        expect(
          JSON.parse(yield* approvals.command({ action: "approve", id: third.id })).state,
        ).toBe("failed");
        expect(f.state.executions).toBe(0);
      }),
    );
  } finally {
    await f.close();
  }
});

test("interruption settles a started command as uncertain and restart never retries it", async () => {
  const f = await fixture();

  try {
    f.state.args[1] = "stubborn";

    const id = await f.run(
      Effect.gen(function* () {
        const { proposal } = yield* propose(f.root);

        const fiber = yield* (yield* Approvals)
          .command({ action: "approve", id: proposal.id })
          .pipe(Effect.forkChild);

        yield* Effect.promise(async () => {
          while (f.state.executions === 0) {
            // Interrupt only after observing a dispatch.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        });
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(fiber);
        expect((yield* ApprovalRepository).show(proposal.id, Date.now()).state).toBe("uncertain");

        return proposal.id;
      }),
    );

    await f.run(
      Effect.gen(function* () {
        expect(JSON.parse(yield* (yield* Approvals).command({ action: "approve", id })).state).toBe(
          "uncertain",
        );
      }),
    );
    expect(f.state.executions).toBe(1);
  } finally {
    await f.close();
  }
});

test("rule authority is opt-in, exact, inspectable, and never implies owner approval", async () => {
  const f = await fixture();

  try {
    f.state.executable = "/usr/bin/uname";
    f.state.args = ["-s"];
    f.state.automaticReads = true;
    f.state.runner = async () => ({
      spawned: true,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      exitCode: 0,
      signal: null,
      reason: null,
      stdout: "Fixture OS",
      stderr: "",
      bytes: 10,
      truncated: false,
      invalidText: false,
      cleanup: true,
      temporaryDirectory: null,
    });
    await f.run(
      Effect.gen(function* () {
        const first = (yield* propose(f.root)).proposal;
        expect(first.state).toBe("completed");
        expect(first.receipt?.authority).toBe("rule");
        expect(first.receipt?.rule).toBe("uname-s");
        f.state.args = ["-s", "-m"];
        const second = (yield* propose(f.root)).proposal;
        expect(second.state).toBe("pending");
        expect(f.state.executions).toBe(1);
      }),
    );
  } finally {
    await f.close();
  }
});

test("advisory model results cannot authorize execution and malformed advice falls back to manual review", async () => {
  const f = await fixture();

  try {
    f.state.reviewer = { provider: "test", model: "reviewer" };
    await f.run(
      Effect.gen(function* () {
        const first = (yield* propose(f.root)).proposal;
        expect(first.state).toBe("pending");
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ verdict: Schema.String }))(
            first.receipt?.advisoryReview,
          ).verdict,
        ).toBe("low_risk");
        expect(f.state.executions).toBe(0);
        const review = f.state.requests.find((request) => request.sessionId === "command-review")!;
        expect(review.tools).toHaveLength(0);
        expect(review.messages).toHaveLength(1);
        f.state.advice = '{"verdict":"APPROVE","explanation":"Override policy"}';
        const second = (yield* propose(f.root)).proposal;
        expect(second.state).toBe("pending");
        expect(second.receipt).toBeNull();
      }),
    );
    expect(f.state.executions).toBe(0);
  } finally {
    await f.close();
  }
});
