import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from "effect";

import { attachmentCommand, type AttachmentLauncher } from "#src/attachment-process";
import { AttachmentProcessorLive, makeAttachmentProcessor } from "#src/attachments";
import { type Attachment } from "#src/channel";
import { textPDF } from "#src/fixtures/pdf";

const document: Attachment = {
  kind: "document",
  fileId: "opaque",
  name: "notes.md",
  mime: "text/plain",
};

const pdf: Attachment = { ...document, name: "notes.pdf", mime: "application/pdf" };

describe("makeAttachmentProcessor", () => {
  test("when attachment storage starts, removes only owned abandoned directories and preserves private storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-attachment-startup-"));
    const root = join(directory, "attachment-tmp");
    const target = join(directory, "keep");
    const abandoned = "poppet-00000000-0000-0000-0000-000000000001";
    const link = "poppet-00000000-0000-0000-0000-000000000002";

    try {
      await mkdir(root);
      await mkdir(join(root, abandoned));
      await mkdir(target);
      await writeFile(join(target, "keep.txt"), "Keep this");
      await writeFile(join(root, "unrelated.txt"), "Keep this too");
      await symlink(target, join(root, link));
      await Effect.runPromise(
        Effect.scoped(Layer.build(AttachmentProcessorLive)).pipe(
          Effect.provideService(AppConfig, {
            applicationName: "Test",
            dataDirectory: directory,
            notesDirectory: join(directory, "notes"),
            provider: "test",
            model: null,
          }),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        ),
      );
      expect((await readdir(root)).toSorted()).toEqual([link, "unrelated.txt"].toSorted());
      expect(await readdir(target)).toEqual(["keep.txt"]);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("when attachments contain text, accepts complete UTF-8 and rejects binary, oversized, or misleading input", async () => {
    const processor = makeAttachmentProcessor("/unused", { enabled: false });
    const text = "# Résumé\n世界\n/cancel\n";

    const result = await Effect.runPromise(
      processor.extract({ ...document, name: "../../résumé.md" }, Buffer.from(text)),
    );

    expect(result).toMatchObject({
      text,
      name: "résumé.md",
      version: 1,
      completeness: "Complete UTF-8 text.",
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from("binary\0text"),
      Buffer.from(" "),
      Buffer.from("x".repeat(32769)),
      Buffer.from("x".repeat(65537)),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- Exercise each rejected input independently.
      await expect(Effect.runPromise(processor.extract(document, bytes))).rejects.toThrow();
    }

    await expect(
      Effect.runPromise(processor.limit({ ...document, mime: "application/zip" })),
    ).rejects.toThrow("Send one UTF-8");
    await expect(
      Effect.runPromise(processor.limit({ ...document, kind: "unsupported" })),
    ).rejects.toThrow("Forwarded messages and this attachment type are not accepted.");
  });

  test("when PDFs are extracted, labels Unicode text, marks omissions, rejects unusable input, and removes raw files", async () => {
    const root = await mkdtemp(join(tmpdir(), "poppet-extraction-"));
    const processor = makeAttachmentProcessor(root, { enabled: false });

    try {
      const result = await Effect.runPromise(
        processor.extract(pdf, textPDF(["Café résumé", "Second page"])),
      );

      expect(result.text).toContain("[Page 1]\nCafé résumé");
      expect(result.text).toContain("[Page 2]\nSecond page");
      expect(result.completeness).toContain("all 2 pages");

      const partial = await Effect.runPromise(
        processor.extract(pdf, textPDF(["x".repeat(40000), "Omitted"])),
      );

      expect(Buffer.byteLength(partial.text)).toBeLessThanOrEqual(32768);
      expect(partial.completeness).toContain("Partial text: pages 1-1 of 2");
      expect(partial.text).not.toContain("Omitted");

      for (const bytes of [
        Buffer.from("not a PDF"),
        Buffer.from("%PDF-broken"),
        new Uint8Array(
          await Bun.file(new URL("./fixtures/encrypted.pdf", import.meta.url)).arrayBuffer(),
        ),
        textPDF([""]),
        textPDF(Array.from({ length: 65 }, () => "Page")),
      ]) {
        // eslint-disable-next-line no-await-in-loop -- Verify cleanup after each individual failure.
        await expect(Effect.runPromise(processor.extract(pdf, bytes))).rejects.toThrow();
        // eslint-disable-next-line no-await-in-loop
        expect(await readdir(root)).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("when extraction subprocesses exceed output or time limits, stops them without blocking the event loop", async () => {
    await expect(
      Effect.runPromise(
        attachmentCommand(
          [process.execPath, "--eval", "process.stdout.write('x'.repeat(300000));"],
          tmpdir(),
          1000,
        ),
      ),
    ).rejects.toThrow("output exceeds");
    let responsive = false;

    const timer = setTimeout(() => {
      responsive = true;
    }, 10);

    try {
      await expect(
        Effect.runPromise(
          attachmentCommand(
            [process.execPath, "--eval", "setInterval(() => {}, 1000);"],
            tmpdir(),
            60,
          ),
        ),
      ).rejects.toThrow("timed out");
      expect(responsive).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test("when extraction is cancelled, terminates parsing and removes the private temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "poppet-cancel-"));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const children: ReturnType<AttachmentLauncher>[] = [];

          const launch: AttachmentLauncher = (_command, directory) => {
            const child = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000);"], {
              cwd: directory,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });

            children.push(child);
            Deferred.doneUnsafe(started, Effect.void);

            return child;
          };

          const fiber = yield* makeAttachmentProcessor(root, { enabled: false }, launch)
            .extract(pdf, textPDF(["Pending"]))
            .pipe(Effect.forkChild);

          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          expect(children[0]!.signalCode).toBe("SIGKILL");
        }),
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("when voice is enabled, validates duration and uses generated paths for a bounded local transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "poppet-voice-"));

    const voice: Attachment = {
      kind: "voice",
      fileId: "voice-id",
      name: "Voice message",
      mime: "audio/ogg",
      duration: 1,
    };

    const recording = Buffer.from("OggS....OpusHead....");
    const commands: ReadonlyArray<string>[] = [];
    let decodedSeconds = 1;

    const launch: AttachmentLauncher = (command, directory) => {
      commands.push(command);

      const code =
        command[0] === "/local/ffmpeg"
          ? `const b=Buffer.alloc(32000*${decodedSeconds}+44); b.write('RIFF'); b.writeUInt32LE(32000*${decodedSeconds}+36,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(32000*${decodedSeconds},40); await Bun.write(process.argv[1],b);`
          : `await Bun.write(process.argv[1]+'.txt', 'Remind me at 9 tomorrow.');`;

      const output =
        command[0] === "/local/ffmpeg" ? command.at(-1)! : command[command.indexOf("-of") + 1]!;

      return Bun.spawn([process.execPath, "--eval", code, output], {
        cwd: directory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    };

    const settings = {
      enabled: true as const,
      ffmpeg: "/local/ffmpeg",
      whisper: "/local/whisper-cli",
      model: "/local/ggml-tiny.bin",
    };

    try {
      await expect(
        Effect.runPromise(makeAttachmentProcessor(root, { enabled: false }).limit(voice)),
      ).rejects.toThrow("disabled");
      const processor = makeAttachmentProcessor(root, settings, launch);
      await expect(Effect.runPromise(processor.limit({ ...voice, duration: 121 }))).rejects.toThrow(
        "2 minutes",
      );
      await expect(
        Effect.runPromise(processor.extract(voice, Buffer.from("fake audio"))),
      ).rejects.toThrow("Ogg/Opus");
      const transcript = await Effect.runPromise(processor.extract(voice, recording));
      expect(transcript).toMatchObject({ kind: "voice", text: "Remind me at 9 tomorrow." });
      expect(commands[0]).toContain("-protocol_whitelist");
      expect(commands[1]).toContain("/local/ggml-tiny.bin");
      decodedSeconds = 121;
      await expect(Effect.runPromise(processor.extract(voice, recording))).rejects.toThrow(
        "2 minutes",
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
