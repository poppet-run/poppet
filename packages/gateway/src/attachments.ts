import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AppConfig, voiceSettings, type VoiceSettings } from "@poppet/config";
import { TextSource } from "@poppet/provider";
import { Context, Effect, Layer, Schema } from "effect";

import {
  attachmentCommand,
  attachmentFailure,
  type AttachmentLauncher,
} from "#src/attachment-process";
import { ChannelError, safeAttachmentName, type Attachment } from "#src/channel";

const pdfResult = Schema.Union([
  Schema.Struct({ text: TextSource.fields.text, completeness: TextSource.fields.completeness }),
  Schema.Struct({ failure: Schema.String.check(Schema.isMaxLength(256)) }),
]);

const documentType = (attachment: Attachment) => {
  const name = attachment.name.toLowerCase();

  if (
    name.endsWith(".pdf") &&
    ["application/pdf", "application/octet-stream", ""].includes(attachment.mime)
  )
    return "pdf";

  if (
    /\.(txt|md|markdown)$/.test(name) &&
    ["text/plain", "text/markdown", "text/x-markdown", "application/octet-stream", ""].includes(
      attachment.mime,
    )
  )
    return "text";
  throw attachmentFailure(
    "Send one UTF-8 .txt, .md, .markdown file, a text-based PDF, or a Telegram voice message.",
  );
};

const limit = (attachment: Attachment, voice: VoiceSettings) => {
  if (attachment.kind === "unsupported")
    throw attachmentFailure(
      "Unsupported attachment. Send one text file, PDF, or voice message directly, outside an album or forwarded message.",
    );
  let maxBytes = 8 * 1024 * 1024;

  if (attachment.kind === "voice") {
    if (!voice.enabled)
      throw attachmentFailure(
        "Voice transcription is disabled. Configure local ffmpeg, whisper.cpp and a speech model in voice settings, then restart the worker.",
      );

    if (attachment.duration !== undefined && attachment.duration > 120)
      throw attachmentFailure("Voice messages must be at most 2 minutes.");

    if (!["audio/ogg", "audio/opus", ""].includes(attachment.mime))
      throw attachmentFailure("Send a Telegram Ogg/Opus voice message.");
  } else if (documentType(attachment) === "text") maxBytes = 65536;

  if (attachment.size !== undefined && attachment.size > maxBytes)
    throw attachmentFailure(
      "Attachment exceeds its download limit (64 KiB for text; 8 MiB for PDF/voice).",
    );

  return maxBytes;
};

const wavDuration = (bytes: Uint8Array) => {
  const data = Buffer.from(bytes);

  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE")
    throw attachmentFailure("Audio decoder returned invalid audio.");
  let valid = false;

  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (start + size > data.length)
      throw attachmentFailure("Audio decoder returned incomplete audio.");
    const name = data.toString("ascii", offset, offset + 4);

    if (name === "fmt " && size >= 16)
      valid =
        data.readUInt16LE(start) === 1 &&
        data.readUInt16LE(start + 2) === 1 &&
        data.readUInt32LE(start + 4) === 16000 &&
        data.readUInt16LE(start + 14) === 16;

    if (name === "data" && valid) return size / 32000;
    offset = start + size + (size % 2);
  }

  throw attachmentFailure("Audio decoder returned no playable audio.");
};

export const makeAttachmentProcessor = (
  root: string,
  voice: VoiceSettings,
  launch?: AttachmentLauncher,
) => ({
  limit: (attachment: Attachment) =>
    Effect.try({
      try: () => limit(attachment, voice),
      catch: (cause) =>
        cause instanceof ChannelError ? cause : attachmentFailure("Invalid attachment metadata."),
    }),
  extract: (attachment: Attachment, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const max = yield* Effect.try({
        try: () => limit(attachment, voice),
        catch: (cause) =>
          cause instanceof ChannelError ? cause : attachmentFailure("Invalid attachment metadata."),
      });

      if (bytes.byteLength > max)
        return yield* Effect.fail(attachmentFailure("Attachment exceeds its download limit."));
      const hash = createHash("sha256").update(bytes).digest("hex");

      const source = {
        kind: attachment.kind === "voice" ? ("voice" as const) : ("document" as const),
        name: safeAttachmentName(attachment.name),
        mime: attachment.mime,
        sha256: hash,
        version: 1 as const,
      };

      if (attachment.kind === "document" && documentType(attachment) === "text") {
        const accepted = yield* Effect.try({
          try: () => {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

            if (
              [...text].some((character) => {
                const code = character.charCodeAt(0);

                return code < 32 && code !== 9 && code !== 10 && code !== 13;
              })
            )
              throw new Error("Binary data");

            if (!text.trim()) throw new Error("Empty text");

            if (Buffer.byteLength(text) > 32768) throw new Error("Too much text");

            return text;
          },
          catch: () =>
            attachmentFailure(
              "Text files must contain nonempty UTF-8 text of at most 32 KiB, without binary control characters. Split a larger file before sending it.",
            ),
        });

        return { ...source, text: accepted, completeness: "Complete UTF-8 text." };
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                const directory = join(root, `poppet-${randomUUID()}`);
                await mkdir(directory, { mode: 0o700 });

                return directory;
              },
              catch: () => attachmentFailure("Cannot create private attachment storage."),
            }),
            (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
          );

          const directory = temporary;
          const input = join(directory, "input");
          yield* Effect.tryPromise({
            try: () => writeFile(input, bytes, { mode: 0o600 }),
            catch: () => attachmentFailure("Cannot write private attachment storage."),
          });

          if (attachment.kind === "document") {
            if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-")
              return yield* Effect.fail(attachmentFailure("The file is not a PDF."));

            const output = yield* attachmentCommand(
              [process.execPath, fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)), input],
              directory,
              30000,
              launch,
            );

            const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(pdfResult))(
              output,
            ).pipe(
              Effect.mapError(() =>
                attachmentFailure("The PDF parser returned an invalid result."),
              ),
            );

            if ("failure" in result) return yield* Effect.fail(attachmentFailure(result.failure));

            return { ...source, ...result };
          }

          if (!voice.enabled)
            return yield* Effect.fail(attachmentFailure("Voice transcription is disabled."));

          if (
            Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "OggS" ||
            !Buffer.from(bytes.subarray(0, 512)).includes(Buffer.from("OpusHead"))
          )
            return yield* Effect.fail(attachmentFailure("The recording is not Ogg/Opus audio."));
          const wav = join(directory, "audio.wav");
          const output = join(directory, "transcript");
          yield* attachmentCommand(
            [
              voice.ffmpeg,
              "-nostdin",
              "-v",
              "error",
              "-protocol_whitelist",
              "file",
              "-f",
              "ogg",
              "-i",
              input,
              "-map_metadata",
              "-1",
              "-vn",
              "-t",
              "121",
              "-ar",
              "16000",
              "-ac",
              "1",
              "-c:a",
              "pcm_s16le",
              "-fs",
              "4000000",
              wav,
            ],
            directory,
            30000,
            launch,
          );

          const duration = yield* Effect.tryPromise({
            try: async () => {
              const info = await stat(wav);

              if (info.size > 4000000) throw new Error("Too large");

              return wavDuration(new Uint8Array(await Bun.file(wav).arrayBuffer()));
            },
            catch: () => attachmentFailure("Cannot decode this recording within the audio limits."),
          });

          if (duration <= 0 || duration > 120)
            return yield* Effect.fail(
              attachmentFailure("Voice messages must contain audio of at most 2 minutes."),
            );
          yield* attachmentCommand(
            [
              voice.whisper,
              "-m",
              voice.model,
              "-f",
              wav,
              "-l",
              "auto",
              "-t",
              "4",
              "-otxt",
              "-of",
              output,
              "-nt",
              "-np",
              "-ng",
            ],
            directory,
            90000,
            launch,
          );

          const transcript = yield* Effect.tryPromise({
            try: async () => {
              const path = `${output}.txt`;
              const info = await stat(path);

              if (!info.isFile() || info.size > 16384) throw new Error("Too much text");

              const text = new TextDecoder("utf-8", { fatal: true })
                .decode(await Bun.file(path).arrayBuffer())
                .trim();

              if (!text) throw new Error("No speech");

              return text;
            },
            catch: () =>
              attachmentFailure(
                "No usable transcript was produced, or it exceeds 16 KiB. Try a shorter, clearer recording.",
              ),
          });

          return {
            ...source,
            text: transcript,
            completeness:
              "Complete local transcript; speech recognition may be inaccurate. Requires subsequent text confirmation before any mutation.",
          };
        }),
      );
    }),
});

export class AttachmentProcessor extends Context.Service<
  AttachmentProcessor,
  ReturnType<typeof makeAttachmentProcessor>
>()("poppet/AttachmentProcessor") {}

export const AttachmentProcessorLive = Layer.effect(
  AttachmentProcessor,
  Effect.gen(function* () {
    const { dataDirectory } = yield* AppConfig;
    const voice = yield* voiceSettings;
    const root = join(dataDirectory, "attachment-tmp");
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(root, { mode: 0o700, recursive: true });

        if (!(await lstat(root)).isDirectory()) throw new Error("Invalid attachment directory");
        await chmod(root, 0o700);

        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^poppet-[a-f0-9-]{36}$/.test(entry.name)) {
            // eslint-disable-next-line no-await-in-loop -- Startup removes only this feature's abandoned directories.
            await rm(join(root, entry.name), { recursive: true, force: true });
          }
        }
      },
      catch: () => attachmentFailure("Cannot initialize private attachment storage."),
    });

    return makeAttachmentProcessor(root, voice);
  }),
);
