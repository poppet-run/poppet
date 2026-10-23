import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { attachmentProcessor } from "#src/attachments";
import { type Attachment } from "#src/channel";

const document: Attachment = {
  kind: "document",
  fileId: "opaque",
  name: "notes.md",
  mime: "text/plain",
};

describe("attachmentProcessor", () => {
  test("when attachments contain text, accepts complete UTF-8 and rejects binary, oversized, or misleading input", async () => {
    const text = "# Résumé\n世界\n/cancel\n";

    const result = await Effect.runPromise(
      attachmentProcessor.extract({ ...document, name: "../../résumé.md" }, Buffer.from(text)),
    );

    expect(result).toMatchObject({
      text,
      name: "résumé.md",
      version: 1,
      completeness: "Complete UTF-8 text.",
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    await Array.fromAsync(
      [
        Buffer.from([0xff]),
        Buffer.from("binary\0text"),
        Buffer.from(" "),
        Buffer.from("x".repeat(32769)),
        Buffer.from("x".repeat(65537)),
      ],
      async (bytes) => {
        await expect(
          Effect.runPromise(attachmentProcessor.extract(document, bytes)),
        ).rejects.toThrow();
      },
    );

    await expect(
      Effect.runPromise(attachmentProcessor.limit({ ...document, mime: "application/zip" })),
    ).rejects.toThrow("Send one UTF-8");
    await expect(
      Effect.runPromise(attachmentProcessor.limit({ ...document, kind: "unsupported" })),
    ).rejects.toThrow("not supported");
  });
});
