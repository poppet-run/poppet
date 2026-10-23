import { createHash } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { ChannelError, safeAttachmentName, type Attachment } from "#src/channel";

const attachmentFailure = (message: string) => new ChannelError({ reason: "attachment", message });

const limit = (attachment: Attachment) => {
  if (
    attachment.kind !== "document" ||
    !/\.(txt|md|markdown)$/.test(attachment.name.toLowerCase()) ||
    !["text/plain", "text/markdown", "text/x-markdown", "application/octet-stream", ""].includes(
      attachment.mime,
    )
  )
    throw attachmentFailure(
      "Send one UTF-8 .txt, .md, or .markdown file directly, outside an album. PDFs, voice messages, and forwarded messages are not supported.",
    );

  if (attachment.size !== undefined && attachment.size > 65536)
    throw attachmentFailure("Text attachments must be at most 64 KiB.");

  return 65536;
};

export const attachmentProcessor = {
  limit: (attachment: Attachment) =>
    Effect.try({
      try: () => limit(attachment),
      catch: (cause) =>
        cause instanceof ChannelError ? cause : attachmentFailure("Invalid attachment metadata."),
    }),
  extract: (attachment: Attachment, bytes: Uint8Array) =>
    Effect.gen(function* () {
      const max = yield* attachmentProcessor.limit(attachment);

      if (bytes.byteLength > max)
        return yield* Effect.fail(attachmentFailure("Attachment exceeds its download limit."));

      const source = {
        kind: "document" as const,
        name: safeAttachmentName(attachment.name),
        mime: attachment.mime,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        version: 1 as const,
      };

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
    }),
};

export class AttachmentProcessor extends Context.Service<
  AttachmentProcessor,
  typeof attachmentProcessor
>()("poppet/AttachmentProcessor") {}

export const AttachmentProcessorLive = Layer.succeed(AttachmentProcessor, attachmentProcessor);
