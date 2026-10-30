import { StringDecoder } from "node:string_decoder";
import { formatWithOptions, stripVTControlCharacters } from "node:util";

import { AgentError } from "@poppet/agent";
import { Console, Deferred, Effect } from "effect";

import type { ChatReasoningWriter, ChatWriter } from "#src/commands/chat/chat";
import type { ChatHistoryMessage } from "#src/commands/chat/history";
import { ChatMarkdown } from "#src/commands/chat/markdown";
import { activityIndicator, type ChatInput } from "#src/commands/chat/prompt";

const escape = "\u001b[";
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (text: string) => Array.from(segments.segment(text), ({ segment }) => segment);

const clean = (text: string) =>
  // oxlint-disable-next-line no-control-regex
  stripVTControlCharacters(text.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, ""))
    .replace(/\r\n?/g, "\n")
    // Terminal control bytes must never be interpreted as message content.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Normalize enhanced keyboard reports while preserving the existing editing shortcuts. */
const chatKey = (key: string) => {
  if (key === `${escape}27;2;13~`) return "newline";
  // oxlint-disable-next-line no-control-regex
  const report = /^\u001b\[(\d+)(?:;(\d+))?u$/.exec(key);

  if (!report) return key;
  const code = Number(report[1]);
  // Caps Lock and Num Lock do not change these shortcuts.
  const modifiers = (Number(report[2] ?? "1") - 1) & ~192;

  if (code === 13 && (modifiers === 1 || modifiers === 2)) return "newline";

  if (modifiers === 4 && code >= 97 && code <= 122) return String.fromCharCode(code & 31);

  if (modifiers === 0 && (code === 13 || code === 127)) return String.fromCharCode(code);

  return key;
};

/** Wrap by terminal cells, without splitting emoji or wide characters. */
export const wrapChatText = (text: string, width: number): string[] => {
  const rows = [""];
  let cells = 0;

  for (const character of characters(text)) {
    if (character === "\n") {
      rows.push("");
      cells = 0;
      continue;
    }

    const size = character === "\t" ? 2 : Bun.stringWidth(character);

    if (cells + size > width && cells > 0) {
      rows.push("");
      cells = 0;
    }

    rows[rows.length - 1] += character === "\t" ? "  " : character;
    cells += size;
  }

  return rows;
};

type Message = {
  kind: "You" | "Poppet" | "Thinking" | "Info" | "Error" | "Welcome" | "Session";
  text: string;
};

type QueuedMessage = { text: string; attachments: readonly string[] };

type Output = Pick<NodeJS.WriteStream, "write" | "columns" | "rows"> &
  Partial<Pick<NodeJS.WriteStream, "hasColors">>;

/** Owns the screen and input for the entire session, including inference. */
export class ChatTerminal {
  private messages: Message[] = [];
  private readonly markdown: ChatMarkdown;
  private draft: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private savedDraft = "";
  private pending = "";
  private paste = false;
  private busy = false;
  private status = "Ready";
  private sessionId: string | undefined;
  private activityTimer: ReturnType<typeof setInterval> | undefined;
  private activityFrame = 0;
  private attachments: readonly string[] = [];
  private queue: QueuedMessage[] = [];
  private active: QueuedMessage | undefined;
  private paused = false;
  private offset = 0;
  private renderedRows = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reader: ((input: ChatInput | null) => void) | undefined;
  private closed = false;

  constructor(
    private readonly output: Output,
    private readonly exit: () => void,
    private readonly color = !process.env.NO_COLOR,
    private readonly failure: () => void = exit,
  ) {
    this.markdown = new ChatMarkdown(color);
  }

  private style(text: string, code: string) {
    return this.color ? `${escape}${code}m${text}${escape}0m` : text;
  }

  private schedule() {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.repaint();
    }, 16);
  }

  private stopActivity() {
    clearInterval(this.activityTimer);
    this.activityTimer = undefined;
  }

  private statusLine(width: number) {
    const details = `${this.attachments.length ? ` · ${this.attachments.length} attached` : ""}${this.offset ? " · History" : ""}`;

    if (this.activityTimer === undefined)
      return this.style(wrapChatText(this.status + details, width)[0]!, "2");

    const label = activityIndicator(
      this.status === "Responding…" ? "Responding" : "Thinking",
      this.activityFrame,
      this.color && (this.output.hasColors?.(256) ?? false),
      width,
    );

    const remaining = width - Bun.stringWidth(stripVTControlCharacters(label));
    const suffix = remaining > 0 ? wrapChatText(details, remaining)[0]! : "";

    return label + this.style(suffix, "2");
  }

  private transcript(width: number, styled: boolean, messages = this.messages) {
    return messages.flatMap((message) => {
      const { kind, text } = message;
      let labelStyle = "2;36";

      if (kind === "You") labelStyle = "1;33";
      else if (kind === "Poppet") labelStyle = "1;36";
      else if (kind === "Error") labelStyle = "31";
      const label = styled ? this.style(kind, labelStyle) : kind;

      const rows =
        kind === "Poppet" ? this.markdown.render(message, width) : wrapChatText(text, width);

      return [
        ...(kind === "Welcome" || kind === "Session" ? [] : [label]),
        ...rows.map((row) =>
          styled &&
          (kind === "Info" || kind === "Thinking" || kind === "Welcome" || kind === "Session")
            ? this.style(row, "2")
            : row,
        ),
        "",
      ];
    });
  }

  repaint = () => {
    try {
      this.render();
    } catch {
      this.failure();
    }
  };

  render = () => {
    if (this.closed) return;
    const width = Math.max(1, (this.output.columns || 80) - 1);
    const height = Math.max(1, this.output.rows || 24);

    if (width < 12 || height < 7) {
      const notice = "Resize terminal to continue".slice(0, width);
      this.output.write(`${escape}?25l${escape}H${escape}2J${notice}`);

      return;
    }

    const inner = width - 4;
    const inputRows = wrapChatText(this.draft.join(""), inner);
    const before = wrapChatText(this.draft.slice(0, this.cursor).join(""), inner);

    // An exact-width line needs a new visual row for the insertion cursor.
    if (Bun.stringWidth(before.at(-1)!) === inner) before.push("");

    if (before.length > inputRows.length) inputRows.push("");
    const composerHeight = Math.min(inputRows.length, Math.floor(height / 3), height - 6);
    const start = Math.max(0, before.length - composerHeight);
    const visibleInput = inputRows.slice(start, start + composerHeight);
    const available = Math.max(0, height - visibleInput.length - 6);
    const queueRows = this.queueRows(width, Math.min(Math.floor(height / 3), available));
    const room = available - queueRows.length;
    const transcript = this.transcript(width, true);

    if (this.offset > 0) this.offset += Math.max(0, transcript.length - this.renderedRows);
    this.renderedRows = transcript.length;
    this.offset = Math.min(this.offset, Math.max(0, transcript.length - room));
    const end = Math.max(0, transcript.length - this.offset);

    const lines = [
      this.style("Poppet chat", "1"),
      "",
      ...transcript.slice(Math.max(0, end - room), end),
    ];

    while (lines.length < room + 2) lines.push("");
    lines.push(this.statusLine(width));
    lines.push(...queueRows);
    lines.push(this.style("╭" + "─".repeat(Math.max(0, width - 2)) + "╮", "2;36"));
    const inputTop = lines.length + 1;

    for (const row of visibleInput)
      lines.push(
        this.style("│", "2;36") +
          " " +
          row +
          " ".repeat(Math.max(0, inner - Bun.stringWidth(row))) +
          " " +
          this.style("│", "2;36"),
      );
    lines.push(this.style("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", "2;36"));
    lines.push(
      this.style(
        wrapChatText(
          "Enter send/queue · Shift+Enter newline · ↑↓ history · PgUp/PgDn scroll · Ctrl-C exit",
          width,
        )[0]!,
        "2",
      ),
    );
    const row = Math.min(height, inputTop + before.length - 1 - start);
    const column = Math.min(width, 3 + Bun.stringWidth(before.at(-1)!));

    const screen = lines
      .slice(-height)
      .map((line) => `${escape}2K${line}`)
      .join("\r\n");

    this.output.write(`${escape}?25l${escape}H${screen}${escape}${row};${column}H${escape}?25h`);
  };

  private queueRows(width: number, limit: number) {
    if ((!this.queue.length && !this.paused) || limit === 0) return [];
    const heading = `${this.paused ? "Queue paused" : "Queued"} · ${this.queue.length}`;
    const rows = [heading];
    const controls = this.paused ? "/queue retry · /queue resume" : "/queue remove N";
    const slots = Math.max(0, limit - 2);
    const shown = this.queue.length > slots ? Math.max(0, slots - 1) : slots;

    for (const [index, message] of this.queue.slice(0, shown).entries()) {
      const files = message.attachments.length ? ` [${message.attachments.length} attached]` : "";
      rows.push(`${index + 1}.${files} ${message.text.replace(/\s+/g, " ")}`);
    }

    if (this.queue.length > shown && slots > 0)
      rows.push(`+${this.queue.length - shown} more · /queue remove N`);

    if (limit > 1) rows.push(controls);

    return rows.map((row) => this.style(wrapChatText(row, width)[0]!, "2;36"));
  }

  /** Only the prompt's next read releases another turn, after the previous send completes. */
  private dispatch() {
    if (this.closed || this.busy || this.paused || !this.reader || !this.queue.length) return;
    const message = this.queue.shift()!;
    const reader = this.reader;
    this.reader = undefined;
    this.busy = true;
    this.active = message;
    reader(message);
    this.schedule();
  }

  read = Effect.callback<ChatInput | null, AgentError>((resume) => {
    this.busy = false;
    this.stopActivity();
    this.status = this.paused ? "Request failed · Queue paused" : "Ready";
    this.reader = (text) => resume(Effect.succeed(text));
    this.dispatch();
    this.schedule();

    return Effect.sync(() => {
      this.reader = undefined;
    });
  });

  /** Keep scoped service diagnostics away from the terminal's input cursor. */
  console = (base: Console.Console): Console.Console => {
    const diagnostic = (...values: readonly unknown[]) => {
      Effect.runSync(this.info(formatWithOptions({ colors: false }, ...values)));
    };

    return {
      ...base,
      log: diagnostic,
      info: diagnostic,
      debug: diagnostic,
      warn: diagnostic,
      error: diagnostic,
    };
  };

  loadingHistory = Effect.sync(() => {
    this.status = "Loading history…";
    this.schedule();
  });

  showHistory = (messages: readonly ChatHistoryMessage[]) =>
    Effect.sync(() => {
      this.status = "Ready";

      for (const message of messages)
        this.messages.push({
          kind: message.role === "user" ? "You" : "Poppet",
          text: clean(message.text),
        });
      this.offset = 0;
      this.schedule();
    });

  session: ChatWriter = (id) =>
    Effect.sync(() => {
      this.sessionId = id;
      const firstMessage = this.messages.findIndex(({ kind }) => kind !== "Welcome");
      this.messages.splice(firstMessage < 0 ? this.messages.length : firstMessage, 0, {
        kind: "Session",
        text: `Session: ${clean(id)}`,
      });
      this.schedule();
    });

  welcome: ChatWriter = (text) =>
    Effect.sync(() => {
      this.messages.push({ kind: "Welcome", text: clean(text).trim() });
      this.schedule();
    });

  info: ChatWriter = (text) =>
    Effect.sync(() => {
      this.messages.push({ kind: "Info", text: clean(text).trim() });
      this.schedule();
    });

  error: ChatWriter = (text) =>
    Effect.sync(() => {
      this.stopActivity();
      this.status = "Request failed";
      this.paused = true;
      this.messages.push({ kind: "Error", text: clean(text) });
      this.schedule();
    });

  begin = (text: string) =>
    Effect.sync(() => {
      this.messages.push({ kind: "You", text: clean(text) });
      this.stopActivity();
      this.activityFrame = 0;
      this.status = "Thinking…";
      this.activityTimer = setInterval(() => {
        this.activityFrame++;
        this.schedule();
      }, 100);
      this.offset = 0;
      this.schedule();
    });

  private append(kind: "Poppet" | "Thinking", text: string) {
    const last = this.messages.at(-1);

    if (last?.kind === kind) last.text += clean(text);
    else this.messages.push({ kind, text: clean(text) });
    this.schedule();
  }

  answer: ChatWriter = (text) =>
    Effect.sync(() => {
      if (!text) return;
      this.status = "Responding…";
      this.append("Poppet", text);
    });

  reasoning: ChatReasoningWriter = (event) =>
    Effect.sync(() => {
      if (event.type === "reasoning-delta") this.append("Thinking", event.text);
    });

  announce: ChatWriter = (text) => this.info(text);

  private insert(text: string) {
    const added = characters(clean(text));
    this.draft.splice(this.cursor, 0, ...added);
    this.cursor += added.length;
  }

  private historyMove(direction: number) {
    if (this.historyIndex === this.history.length) this.savedDraft = this.draft.join("");
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.draft = characters(this.history[this.historyIndex] ?? this.savedDraft);
    this.cursor = this.draft.length;
  }

  private submit() {
    const text = this.draft.join("");
    const command = text.trim();

    if (!command) return true;
    this.history.push(text);
    this.historyIndex = this.history.length;
    this.savedDraft = "";
    this.draft = [];
    this.cursor = 0;

    if (command === "/exit") {
      this.exit();

      return false;
    }

    const attach = /^\/attach\s+(.+)$/.exec(command);

    if (attach) {
      this.attachments = [...this.attachments, attach[1]!];

      return true;
    }

    if (/^\/queue(?:\s|$)/.test(command)) {
      const remove = /^\/queue remove ([1-9]\d*)$/.exec(command);

      if (remove && Number(remove[1]) <= this.queue.length)
        this.queue.splice(Number(remove[1]) - 1, 1);
      else if (this.paused && (command === "/queue resume" || command === "/queue retry")) {
        if (command === "/queue retry" && this.active) this.queue.unshift(this.active);
        this.paused = false;
        this.status = "Ready";
        this.dispatch();
      } else
        this.messages.push({
          kind: "Info",
          text: "Use /queue remove N for a queued message. After a failed turn, use /queue retry or /queue resume.",
        });

      return true;
    }

    this.queue.push({ text, attachments: this.attachments });
    this.attachments = [];
    this.dispatch();

    return true;
  }

  /** Buffers escape sequences and bracketed paste across input chunks. */
  input = (text: string) => {
    if (this.closed) return;
    this.pending += text;

    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf(`${escape}201~`);

        if (end < 0) break;
        this.insert(this.pending.slice(0, end));
        this.pending = this.pending.slice(end + 6);
        this.paste = false;
        continue;
      }

      const keys = [
        `${escape}200~`,
        `${escape}A`,
        `${escape}B`,
        `${escape}C`,
        `${escape}D`,
        `${escape}H`,
        `${escape}F`,
        `${escape}3~`,
        `${escape}5~`,
        `${escape}6~`,
        "\u001b\r",
      ];

      // oxlint-disable-next-line no-control-regex
      const control = /^\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O[A-Z])/.exec(this.pending)?.[0];

      if (!control && (this.pending.startsWith(escape) || this.pending === "\u001bO")) break;
      const sequence = control ?? keys.find((key) => this.pending.startsWith(key));

      if (!sequence && keys.some((key) => key.startsWith(this.pending))) break;
      const key = sequence ?? characters(this.pending)[0]!;
      this.pending = this.pending.slice(key.length);

      switch (chatKey(key)) {
        case `${escape}200~`:
          this.paste = true;
          break;
        case "\u0003":
          this.exit();

          return;
        case "\u0004":
          if (!this.draft.length && !this.busy) {
            this.exit();

            return;
          }

          break;
        case "\r": {
          if (!this.submit()) return;
          break;
        }

        case "newline":
        case "\u001b\r":
          this.insert("\n");
          break;
        case "\u007f":
        case "\b":
          if (this.cursor > 0) this.draft.splice(--this.cursor, 1);
          break;
        case `${escape}3~`:
          this.draft.splice(this.cursor, 1);
          break;
        case `${escape}D`:
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case `${escape}C`:
          this.cursor = Math.min(this.draft.length, this.cursor + 1);
          break;
        case `${escape}A`:
          this.historyMove(-1);
          break;
        case `${escape}B`:
          this.historyMove(1);
          break;
        case "\u001bOH":
        case `${escape}1~`:
        case `${escape}H`:
        case "\u0001":
          this.cursor = 0;
          break;
        case "\u001bOF":
        case `${escape}4~`:
        case `${escape}F`:
        case "\u0005":
          this.cursor = this.draft.length;
          break;
        case `${escape}5~`:
          this.offset += Math.max(1, (this.output.rows || 24) - 8);
          break;
        case `${escape}6~`:
          this.offset = Math.max(0, this.offset - Math.max(1, (this.output.rows || 24) - 8));
          break;
        case "\u0015":
          this.draft.splice(0, this.cursor);
          this.cursor = 0;
          break;
        default:
          if (!key.startsWith("\u001b") && key >= " " && key !== "\u007f") this.insert(key);
      }
    }

    this.schedule();
  };

  close() {
    this.closed = true;
    this.stopActivity();
    clearTimeout(this.timer);
    this.reader = undefined;
    this.queue = [];
    this.active = undefined;
    this.attachments = [];
    this.output.write(`${escape}<u${escape}?2004l${escape}0m${escape}?25h${escape}?1049l`);
    this.output.write(
      this.sessionId === undefined
        ? "Chat closed. No session was created.\n"
        : `Resume this session with:\n  poppet chat interactive ${this.sessionId}\n`,
    );
  }
}

export const openChatTerminal = Effect.gen(function* () {
  const stopped = yield* Deferred.make<void, AgentError>();
  const stop = () => Effect.runSync(Deferred.succeed(stopped, undefined));

  const failure = () =>
    Effect.runSync(
      Deferred.fail(
        stopped,
        new AgentError({ reason: "interrupted", message: "The chat terminal closed." }),
      ),
    );

  const terminal = new ChatTerminal(process.stdout, stop, !process.env.NO_COLOR, failure);
  const decoder = new StringDecoder("utf8");
  const input = (data: Buffer) => terminal.input(decoder.write(data));
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;

  // Register restoration before any terminal mutation, including failed setup.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.stdin.off("data", input);
      process.stdin.off("error", failure);
      process.stdin.off("end", stop);
      process.stdout.off("resize", terminal.repaint);
      process.stdout.off("error", failure);
      process.stdin.setRawMode(wasRaw);

      if (wasFlowing !== true) process.stdin.pause();
      terminal.close();
    }),
  );

  yield* Effect.sync(() => {
    process.stdin.setRawMode(true);
    process.stdin.on("data", input);
    process.stdin.on("error", failure);
    process.stdin.on("end", stop);
    process.stdout.on("resize", terminal.repaint);
    process.stdout.on("error", failure);
    process.stdout.write(`${escape}?1049h${escape}>1u${escape}?2004h${escape}2J`);
    terminal.render();
    process.stdin.resume();
  });

  return { terminal, stopped: Deferred.await(stopped) };
});
