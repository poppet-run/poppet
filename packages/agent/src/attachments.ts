import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

import type { AttachmentType } from "@poppet/provider";

import { AgentError } from "#src/errors";
import type { ChatPolicy } from "#src/settings";

/** A file the owner attached, before its type is identified and limits are checked. */
export interface AttachmentInput {
  readonly name: string;
  readonly body: Uint8Array;
}

const textExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".swift",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".sh",
  ".fish",
  ".zsh",
  ".sql",
  ".diff",
  ".patch",
]);

const startsWith = (body: Uint8Array, bytes: ReadonlyArray<number>, offset = 0) =>
  bytes.every((byte, index) => body[offset + index] === byte);

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

// The bytes decide an image's type; a declared type or extension is never trusted.
const imageType = (body: Uint8Array): AttachmentType | null => {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  if (startsWith(body, [0xff, 0xd8, 0xff])) return "image/jpeg";

  if (startsWith(body, ascii("GIF87a")) || startsWith(body, ascii("GIF89a"))) return "image/gif";

  if (startsWith(body, ascii("RIFF")) && startsWith(body, ascii("WEBP"), 8)) return "image/webp";

  return null;
};

const isText = (body: Uint8Array) => {
  if (body.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);

    return true;
  } catch {
    return false;
  }
};

// Keep a readable single-line file name; a path supplied by a client is reduced to its last part.
const displayName = (name: string) => {
  const clean = basename(name.replaceAll("\\", "/"))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim();

  return [...(clean || "attachment")].slice(0, 255).join("");
};

const rejected = (name: string, reason: string) =>
  new AgentError({
    reason: "attachment",
    message: `Cannot attach ${JSON.stringify(name)}: ${reason}`,
  });

const readableSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`
    : `${Math.round((bytes / 1024) * 10) / 10} KiB`;

/** Identifies one file by its contents and checks it against the per-file limits. */
export const identifyAttachment = (input: AttachmentInput, policy: ChatPolicy) => {
  const name = displayName(input.name);
  const image = imageType(input.body);

  if (image !== null) {
    if (input.body.length > policy.imageBytes)
      throw rejected(name, `images are limited to ${readableSize(policy.imageBytes)}.`);

    return { name, mediaType: image };
  }

  if (!textExtensions.has(extname(name).toLowerCase()))
    throw rejected(
      name,
      "only PNG, JPEG, WebP, and GIF images and plain-text files are supported.",
    );

  if (input.body.length > policy.textFileBytes)
    throw rejected(name, `text files are limited to ${readableSize(policy.textFileBytes)}.`);

  if (!isText(input.body)) throw rejected(name, "the file is not UTF-8 text.");

  return { name, mediaType: "text/plain" as const };
};

/** Validates a message's files and assigns each the ID its saved reference will carry. */
export const prepareAttachments = (inputs: ReadonlyArray<AttachmentInput>, policy: ChatPolicy) => {
  if (inputs.length > policy.attachmentsPerMessage)
    throw new AgentError({
      reason: "attachment",
      message: `Attach at most ${policy.attachmentsPerMessage} files to one message.`,
    });

  const attachments = inputs.map((input) => ({
    id: randomUUID(),
    ...identifyAttachment(input, policy),
    body: input.body,
  }));

  return {
    references: attachments.map(({ id, name, mediaType, body }) => ({
      id,
      name,
      mediaType,
      size: body.length,
    })),
    attachments,
  };
};
