import { stripVTControlCharacters } from "node:util";

import { Marked } from "marked";
import { defaultSheet, markedTerminal } from "marked-terminal";
import wrapAnsi from "wrap-ansi";

const plain = (text: string) => text;

/** Each line carries its own styling so a scrolled viewport can start anywhere. */
const style = (open: number, close: number, color: boolean) => (text: string) => {
  if (!color) return text;
  const start = `\u001b[${open}m`;
  const end = `\u001b[${close}m`;

  return text
    .split("\n")
    .map((line) => start + line.replaceAll(end, end + start) + end)
    .join("\n");
};

/** Only renderer styling may survive into the screen, never cursor or image commands. */
const safeOutput = (text: string) => {
  return (
    text
      // oxlint-disable-next-line no-control-regex
      .split(/(\u001b\[[\d;]*m)/g)
      .map((part, index) => {
        if (index % 2 === 1) return part;

        // oxlint-disable-next-line no-control-regex
        return stripVTControlCharacters(part).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      })
      .join("")
  );
};

/** Reflow can insert newlines inside styles; restore our basic SGR styles on each row. */
const independentLines = (text: string) => {
  const active = new Map<number, number>();

  return text
    .split("\n")
    .map((line) => {
      const prefix = [...active.values()].map((code) => `\u001b[${code}m`).join("");

      // oxlint-disable-next-line no-control-regex
      for (const match of line.matchAll(/\u001b\[([\d;]*)m/g)) {
        for (const code of match[1]!.split(";").map(Number)) {
          if (code === 0) active.clear();
          else if (code === 22) {
            active.delete(1);
            active.delete(2);
          } else if ([23, 24, 29].includes(code)) active.delete(code - 20);
          else if (code === 39) active.delete(39);
          else if (code >= 30 && code <= 37) active.set(39, code);
          else if ([1, 2, 3, 4, 9].includes(code)) active.set(code, code);
        }
      }

      return prefix + line + "\u001b[0m";
    })
    .join("\n");
};

/** Cache by message identity and text; streaming and resizing invalidate only affected rows. */
export class ChatMarkdown {
  private cache = new WeakMap<{ text: string }, { text: string; width: number; rows: string[] }>();
  private parser: Marked | undefined;
  private width = 0;

  constructor(private readonly color: boolean) {}

  render(message: { text: string }, width: number): string[] {
    const cached = this.cache.get(message);

    if (cached?.text === message.text && cached.width === width) return cached.rows;

    if (this.width !== width || !this.parser) {
      const cyan = style(36, 39, this.color);
      const bold = style(1, 22, this.color);
      const muted = style(2, 22, this.color);
      const sheet = Object.fromEntries(Object.keys(defaultSheet).map((key) => [key, plain]));
      Object.assign(sheet, {
        keyword: cyan,
        built_in: cyan,
        type: cyan,
        string: style(32, 39, this.color),
        number: style(35, 39, this.color),
        literal: cyan,
        comment: muted,
        meta: muted,
      });
      this.parser = new Marked(
        markedTerminal(
          {
            width,
            reflowText: true,
            showSectionPrefix: false,
            emoji: false,
            hyperlinks: false,
            images: false,
            heading: (text) => bold(cyan(text)),
            firstHeading: (text) => bold(cyan(text)),
            strong: bold,
            em: style(3, 23, this.color),
            codespan: cyan,
            code: plain,
            blockquote: muted,
            html: muted,
            hr: muted,
            del: style(9, 29, this.color),
            link: plain,
            href: cyan,
            listitem: plain,
            table: plain,
            paragraph: plain,
            text: plain,
            tab: 2,
            tableOptions: { style: { head: [], border: [] } },
          },
          { sheet, subset: ["javascript", "typescript", "json", "bash", "python", "swift"] },
        ),
      );
      this.width = width;
    }

    let rendered: string;

    try {
      rendered = this.parser.parse(message.text, { async: false });
    } catch {
      // A partial or unsupported construct must not interrupt the conversation.
      rendered = message.text;
    }

    const safe = safeOutput(rendered);

    const output = this.color
      ? independentLines(safe.replace(/\n+$/, ""))
      : stripVTControlCharacters(safe);

    const rows = wrapAnsi(output.replace(/\n+$/, ""), width, { hard: true, trim: false }).split(
      "\n",
    );

    this.cache.set(message, { text: message.text, width, rows });

    return rows;
  }
}
