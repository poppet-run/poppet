import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { proto } from "baileys";
import { Effect } from "effect";

import { openWhatsAppAuth } from "#src/auth";

const noFailure = () => undefined;

describe.concurrent("WhatsApp protected authentication", () => {
  test("reopens binary keys, credentials and outgoing identities with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-wa-auth-"));

    try {
      const original = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* openWhatsAppAuth(directory, noFailure);
            auth.saveCreds({ registered: true, me: { id: "447700900001:1@s.whatsapp.net" } });
            yield* Effect.promise(async () =>
              auth.state.keys.set({
                "pre-key": { one: auth.state.creds.noiseKey },
                session: { owner: Buffer.from([1, 2, 3]) },
                "app-state-sync-key": {
                  app: proto.Message.AppStateSyncKeyData.fromObject({
                    keyData: Buffer.from([4, 5, 6]),
                  }),
                },
              }),
            );
            auth.rememberOutgoing("outgoing-id");
            expect(
              (yield* Effect.promise(() => stat(join(directory, "channels/whatsapp-auth.sqlite"))))
                .mode & 0o777,
            ).toBe(0o600);

            return [...auth.state.creds.noiseKey.private];
          }),
        ),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* openWhatsAppAuth(directory, noFailure);
            expect([...auth.state.creds.noiseKey.private]).toEqual(original);
            expect(auth.state.creds.registered).toBe(true);
            expect(auth.state.creds.me?.id).toBe("447700900001:1@s.whatsapp.net");

            const session = yield* Effect.promise(async () =>
              auth.state.keys.get("session", ["owner"]),
            );

            expect([...session.owner!]).toEqual([1, 2, 3]);

            const app = yield* Effect.promise(async () =>
              auth.state.keys.get("app-state-sync-key", ["app"]),
            );

            expect(app.app).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
            expect([...app.app!.keyData!]).toEqual([4, 5, 6]);
            expect(auth.isOutgoing("outgoing-id")).toBe(true);

            const blocked = yield* Effect.scoped(openWhatsAppAuth(directory, noFailure)).pipe(
              Effect.result,
            );

            expect(blocked).toHaveProperty("failure.reason", "configuration");
            auth.reset();
            expect(auth.state.creds.registered).toBe(false);
            expect(
              yield* Effect.promise(async () => auth.state.keys.get("session", ["owner"])),
            ).toEqual({});
            expect(auth.isOutgoing("outgoing-id")).toBe(true);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back a failed key batch and stops further writes without exposing key material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-wa-rollback-"));
    let failed = 0;

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* openWhatsAppAuth(directory, () => {
              failed++;
            });

            using database = new Database(join(directory, "channels/whatsapp-auth.sqlite"));
            database.run(
              "CREATE TRIGGER reject_key BEFORE INSERT ON auth WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'private key material'); END",
            );
            expect(() =>
              auth.state.keys.set({
                session: { good: Buffer.from("private"), bad: Buffer.from("private") },
              }),
            ).toThrow("Cannot read or persist");
            expect(database.query("SELECT id FROM auth WHERE kind = 'session'").all()).toEqual([]);
            expect(auth.failed()).toBe(true);
            expect(failed).toBe(1);
            expect(() => auth.saveCreds({})).toThrow("Cannot read or persist");
            expect(failed).toBe(1);
          }),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["corrupt", "symlink"])(
    "refuses %s state without silently replacing credentials",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-wa-invalid-"));
      const path = join(directory, "channels/whatsapp-auth.sqlite");

      try {
        await Effect.runPromise(Effect.scoped(openWhatsAppAuth(directory, noFailure)));

        if (kind === "corrupt") {
          using database = new Database(path);
          database.run(
            "UPDATE auth SET payload = 'private-corrupt-credential' WHERE kind = 'creds'",
          );
        } else {
          await rm(path);
          await symlink(join(directory, "outside"), path);
        }

        const result = await Effect.runPromise(
          Effect.scoped(openWhatsAppAuth(directory, noFailure)).pipe(Effect.result),
        );

        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("private-corrupt-credential");

        if (kind === "corrupt") {
          using database = new Database(path);
          expect(database.query("SELECT payload FROM auth WHERE kind = 'creds'").get()).toEqual({
            payload: "private-corrupt-credential",
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("the installed Signal dependency never logs private session objects during rotation", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
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
    record.closeSession(session);
    record.openSession(session);
    for (let index = 0; index < 41; index++) {
      const closed = SessionRecord.createEntry();
      closed.indexInfo = { closed: index };
      closed.currentRatchet = session.currentRatchet;
      record.sessions[index] = closed;
    }
    record.removeOldSessions();
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
