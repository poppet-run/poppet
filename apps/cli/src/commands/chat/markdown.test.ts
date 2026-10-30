import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { ChatMarkdown } from "#src/commands/chat/markdown";

const visible = (rows: string[]) => rows.map(stripVTControlCharacters).join("\n");

test.each([false, true])("renders Markdown with colour=%j while fitting the viewport", (color) => {
  const renderer = new ChatMarkdown(color);

  const rows = renderer.render(
    {
      text: "# Heading\n\nSome **bold** and *italic* with `inline code`.\n\n- First item\n- Second item\n\n> A quotation\n\n[Docs](https://example.com/docs)\n\n```typescript\nconst answer = 42;\n```\n\n| Key | Value |\n| --- | --- |\n| greeting | Hello 👩‍💻 |",
    },
    36,
  );

  const text = visible(rows);
  expect(text).toContain("Heading");
  expect(text).not.toContain("# Heading");
  expect(text).not.toContain("**bold**");
  expect(text.replace(/\s+/g, " ")).toContain("inline code");
  expect(text).toContain("const answer = 42;");
  expect(text).not.toContain("```");
  expect(text).toContain("https://example.com/docs");
  expect(text).toContain("greeting");
  expect(rows.every((row) => Bun.stringWidth(row) <= 36)).toBe(true);
  expect(rows.join("").includes("\u001b[")).toBe(color);
});

test("reuses unchanged messages, updates streamed fences, and reflows on resize", () => {
  const renderer = new ChatMarkdown(false);
  const message = { text: "A **streaming" };
  const first = renderer.render(message, 40);
  expect(renderer.render(message, 40)).toBe(first);
  message.text += " answer**\n\n```js\nconst longName = 'still streaming';";
  const partial = renderer.render(message, 40);
  expect(visible(partial)).toContain("still streaming");
  expect(visible(partial)).not.toContain("```js");
  message.text += "\n```\n\nFinished.";
  const complete = renderer.render(message, 40);
  expect(visible(complete)).toContain("Finished.");
  expect(renderer.render(message, 40)).toBe(complete);
  const narrow = renderer.render(message, 14);
  expect(narrow.every((row) => Bun.stringWidth(row) <= 14)).toBe(true);
  expect(visible(narrow).replaceAll("\n", "")).toContain("still streaming");
});

test("wrapped styles are self-contained and content cannot move the terminal cursor", () => {
  const renderer = new ChatMarkdown(true);

  const rows = renderer.render(
    {
      text:
        "**" +
        "wide 界 👩‍💻 ".repeat(8).trimEnd() +
        "**\n\n![image](file:///missing.png)\n\n&#27;[2JKeep this text",
    },
    16,
  );

  expect(rows.every((row) => Bun.stringWidth(row) <= 16)).toBe(true);
  expect(rows.filter((row) => row.includes("wide")).every((row) => row.includes("\u001b[1m"))).toBe(
    true,
  );
  expect(rows.join("\n")).not.toContain("\u001b[2J");
  expect(rows.join("\n")).not.toContain("\u001b]");
  expect(visible(rows)).toContain("image");
  expect(visible(rows).replace(/\s+/g, " ")).toContain("Keep this text");
});
