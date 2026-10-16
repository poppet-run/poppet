import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the installed Signal dependency never logs private session objects during rotation", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { strict as assert } from "node:assert";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.resolve("baileys"));
    const { SessionRecord } = require("libsignal");
    const record = new SessionRecord();
    const session = SessionRecord.createEntry();
    session.indexInfo = { closed: -1 };
    session.currentRatchet = {
      rootKey: Buffer.from("secret-root-key"),
      ephemeralKeyPair: { privKey: Buffer.from("secret-private-key") },
    };
    record.closeSession(session);
    assert(session.indexInfo.closed >= 0);
    record.closeSession(session);
    record.openSession(session);
    assert.equal(session.indexInfo.closed, -1);
    for (let index = 0; index < 41; index++) {
      const closed = SessionRecord.createEntry();
      closed.indexInfo = { closed: index };
      closed.currentRatchet = session.currentRatchet;
      record.sessions[index] = closed;
    }
    record.removeOldSessions();
    assert.equal(Object.keys(record.sessions).length, 40);
    console.log("session rotation verified");
  `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(code).toBe(0);
  expect(errors).toBe("");
  expect(output.trim()).toBe("session rotation verified");
});
