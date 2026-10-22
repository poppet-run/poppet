import { randomUUID } from "node:crypto";
/* eslint-disable no-await-in-loop -- Path checks and bounded filesystem traversal must run sequentially. */
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppConfig } from "@poppet/config";
import type { Output, Tool } from "@poppet/provider";
import { Context, Effect, Layer, Schema } from "effect";

import { byteSize } from "#src/context";
import { AgentError } from "#src/errors";
import { ChatSettings } from "#src/settings";

const Path = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

const ReadArguments = Schema.Struct({ path: Path });

const SearchArguments = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256)),
});

const SaveArguments = Schema.Struct({
  path: Path,
  content: Schema.String.check(Schema.isMaxLength(65536)),
});

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const maxNoteBytes = 65536;

// ChatGPT reserves "notes" for its own tools.
const namespace = "poppet_notes";

const definition = (
  name: string,
  description: string,
  argumentsSchema: Schema.Constraint,
): Tool => ({
  name,
  namespace,
  description,
  parameters: Schema.decodeUnknownSync(Schema.JsonObject)(
    Schema.toJsonSchemaDocument(argumentsSchema, { onExcessProperty: "error" }).schema,
  ),
});

export const noteTools: ReadonlyArray<Tool> = [
  definition(
    "read_note",
    "Read a UTF-8 .md, .markdown or .txt note within the notes directory. Large notes are truncated explicitly.",
    ReadArguments,
  ),
  definition(
    "search_notes",
    "Find literal text in UTF-8 notes. Returns relative paths, line numbers and matching text. Search is bounded and may be truncated.",
    SearchArguments,
  ),
  definition(
    "save_note",
    "Create or atomically replace a UTF-8 note within the notes directory. Use only when the user requests a note to be saved. Existing content is replaced.",
    SaveArguments,
  ),
];

/** Validated arguments for one of the agent's allowed note operations. */
export type NoteCall =
  | { readonly name: "read_note"; readonly path: string }
  | { readonly name: "search_notes"; readonly query: string }
  | { readonly name: "save_note"; readonly path: string; readonly content: string };

/** Checks the tool namespace, name, and JSON arguments before any note operation executes. */
export const decodeNoteCall = (
  call: Extract<Output, { type: "tool-call" }>,
): Effect.Effect<NoteCall, AgentError> => {
  if (call.namespace !== namespace)
    return Effect.fail(
      new AgentError({
        reason: "tool-permission",
        message: "The requested tool is not allowed in this run.",
      }),
    );
  const options = { onExcessProperty: "error" } as const;

  const invalid = () =>
    new AgentError({
      reason: "tool-arguments",
      message: `Invalid arguments for ${namespace}.${call.name}.`,
    });

  switch (call.name) {
    case "read_note":
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(ReadArguments),
        options,
      )(call.arguments).pipe(
        Effect.map((args): NoteCall => ({ name: "read_note", ...args })),
        Effect.mapError(invalid),
      );
    case "search_notes":
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(SearchArguments),
        options,
      )(call.arguments).pipe(
        Effect.map((args): NoteCall => ({ name: "search_notes", ...args })),
        Effect.mapError(invalid),
      );
    case "save_note":
      return Schema.decodeUnknownEffect(
        Schema.fromJsonString(SaveArguments),
        options,
      )(call.arguments).pipe(
        Effect.map((args): NoteCall => ({ name: "save_note", ...args })),
        Effect.mapError(invalid),
      );
    default:
      return Effect.fail(
        new AgentError({
          reason: "tool-permission",
          message: "The requested tool is not allowed in this run.",
        }),
      );
  }
};

/** Executes bounded note operations within the configured directory and returns JSON text. */
export class Notes extends Context.Service<
  Notes,
  {
    readonly execute: (
      call: NoteCall,
      selected?: ReadonlyArray<string> | null,
    ) => Effect.Effect<string, AgentError>;
  }
>()("poppet/Notes") {}

const forbidden = () =>
  new AgentError({
    reason: "tool-permission",
    message:
      "Notes must be regular .md, .markdown or .txt files inside the configured notes directory. Symlinks and hard links are not allowed.",
  });

const optionalInfo = (path: string) =>
  lstat(path).catch((cause: unknown) => {
    if (Schema.is(MissingFile)(cause)) return null;
    throw cause;
  });

const checkDirectory = async (path: string) => {
  const info = await lstat(path);

  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw forbidden();

  return info;
};

// Check every parent as well as the target so a nested link cannot escape the notes directory.
const notePath = async (root: string, requested: string, createParents: boolean) => {
  if (requested.includes("\0")) throw forbidden();
  const target = resolve(root, requested);
  const local = relative(root, target);

  if (
    !local ||
    isAbsolute(local) ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    ![".md", ".markdown", ".txt"].includes(extname(target).toLowerCase())
  )
    throw forbidden();
  await checkDirectory(root);
  let parent = root;

  for (const component of local.split(sep).slice(0, -1)) {
    parent = join(parent, component);

    if (createParents && !(await optionalInfo(parent))) await mkdir(parent, { mode: 0o700 });
    await checkDirectory(parent);
  }

  const info = await optionalInfo(target);

  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw forbidden();

  return target;
};

const readText = async (path: string, signal: AbortSignal) => {
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.nlink !== 1) throw forbidden();
    const buffer = Buffer.alloc(maxNoteBytes + 1);
    let bytesRead = 0;

    while (bytesRead < buffer.length) {
      signal.throwIfAborted();
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);

      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }

    signal.throwIfAborted();

    // A streaming decode drops only an incomplete UTF-8 suffix at the byte cap.
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, Math.min(bytesRead, maxNoteBytes)),
      { stream: bytesRead > maxNoteBytes },
    );

    if (content.includes("\0"))
      throw new AgentError({ reason: "tool-arguments", message: "The note is not UTF-8 text." });

    return { content, truncated: bytesRead > maxNoteBytes };
  } finally {
    await handle.close();
  }
};

export const validateProjectNotes = (root: string, paths: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      if (paths.length === 0) return;
      const original = await lstat(root);

      if (!original.isDirectory() || original.isSymbolicLink()) throw forbidden();
      const canonical = await realpath(root);
      const current = await lstat(root);

      if (current.dev !== original.dev || current.ino !== original.ino || current.isSymbolicLink())
        throw forbidden();

      for (const path of paths) await notePath(canonical, path, false);
    },
    catch: () =>
      new AgentError({
        reason: "invalid-request",
        message:
          "Project note selections must resolve through the existing notes directory without symlinks or hard links.",
      }),
  });

const selectedSearch = async (
  root: string,
  paths: ReadonlyArray<string>,
  query: string,
  limit: number,
  signal: AbortSignal,
) => {
  const matches: NoteMatch[] = [];
  let truncated = false;

  for (const path of paths) {
    const note = await readText(await notePath(root, path, false), signal);
    truncated ||= note.truncated;

    for (const [index, line] of note.content.split("\n").entries()) {
      if (!line.toLowerCase().includes(query.toLowerCase())) continue;
      const match = { path, line: index + 1, text: line.slice(0, 1000) };
      truncated ||= line.length > 1000;

      if (
        matches.length === 100 ||
        byteSize(JSON.stringify({ matches: [...matches, match], truncated: true })) > limit
      )
        return JSON.stringify({ matches, truncated: true });
      matches.push(match);
    }
  }

  return JSON.stringify({ matches, truncated });
};

const readResult = async (root: string, requested: string, limit: number, signal: AbortSignal) => {
  const path = await notePath(root, requested, false);
  const text = await readText(path, signal);
  const local = relative(root, path);
  let content = text.content;
  let truncated = text.truncated;
  let output = JSON.stringify({ path: local, content, truncated });

  while (byteSize(output) > limit) {
    if (content.length === 0)
      throw new AgentError({
        reason: "tool-limit",
        message: "The tool result cannot fit the content budget.",
      });
    content = content.slice(0, Math.floor(content.length / 2));

    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    truncated = true;
    output = JSON.stringify({ path: local, content, truncated });
  }

  return output;
};

interface NoteMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const searchResult = async (root: string, query: string, limit: number, signal: AbortSignal) => {
  const directories = [root];
  const matches: NoteMatch[] = [];
  const needle = query.toLowerCase();
  let scanned = 0;
  let visited = 0;
  let truncated = false;

  while (directories.length > 0) {
    signal.throwIfAborted();
    const directory = directories.pop();

    if (!directory) break;

    if (++visited > 128) {
      truncated = true;
      break;
    }

    await checkDirectory(directory);
    const entries: Dirent[] = [];

    for await (const entry of await opendir(directory)) {
      if (entries.length === 1000)
        throw new AgentError({
          reason: "tool-limit",
          message: "The notes directory exceeds the search entry limit.",
        });
      entries.push(entry);
    }

    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (visited + directories.length >= 128) truncated = true;
        else directories.push(path);
        continue;
      }

      if (!entry.isFile() || ![".md", ".markdown", ".txt"].includes(extname(path).toLowerCase()))
        continue;

      if (++scanned > 128) return JSON.stringify({ matches, truncated: true });
      const checked = await notePath(root, path, false);
      const note = await readText(checked, signal);
      truncated ||= note.truncated;

      for (const [index, line] of note.content.split("\n").entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        const match = { path: relative(root, path), line: index + 1, text: line.slice(0, 1000) };

        if (line.length > 1000) truncated = true;

        if (
          matches.length === 100 ||
          byteSize(JSON.stringify({ matches: [...matches, match], truncated: true })) > limit
        )
          return JSON.stringify({ matches, truncated: true });
        matches.push(match);
      }
    }
  }

  return JSON.stringify({ matches, truncated });
};

// Sync a temporary file before replacement, then sync the directory before reporting success.
const saveResult = async (
  root: string,
  call: Extract<NoteCall, { name: "save_note" }>,
  limit: number,
) => {
  const bytes = byteSize(call.content);

  if (bytes > maxNoteBytes)
    throw new AgentError({
      reason: "tool-limit",
      message: "A saved note cannot exceed 65536 UTF-8 bytes.",
    });
  const path = await notePath(root, call.path, true);
  const output = JSON.stringify({ path: relative(root, path), saved: true, bytes });

  if (byteSize(output) > limit)
    throw new AgentError({
      reason: "tool-limit",
      message: "The tool result cannot fit the content budget.",
    });
  const parent = dirname(path);
  const original = await checkDirectory(parent);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(temporary, "wx", 0o600);

    try {
      await handle.writeFile(call.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await notePath(root, call.path, false);
    const current = await checkDirectory(parent);

    if (current.dev !== original.dev || current.ino !== original.ino) throw forbidden();
    await rename(temporary, path);

    const directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }

  return output;
};

export const NotesLive = Layer.effect(
  Notes,
  Effect.gen(function* () {
    const { notesDirectory } = yield* AppConfig;
    const { toolBytes } = yield* ChatSettings;
    let root: string | null = null;

    const execute = (call: NoteCall, selected?: ReadonlyArray<string> | null) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (
            selected !== undefined &&
            selected !== null &&
            call.name !== "search_notes" &&
            !selected.includes(call.path)
          )
            throw new AgentError({
              reason: "tool-permission",
              message: "This note is outside the saved project selection.",
            });

          if (root === null) {
            await mkdir(notesDirectory, { recursive: true, mode: 0o700 });
            const info = await lstat(notesDirectory);

            if (!info.isDirectory() || info.isSymbolicLink()) throw forbidden();
            root = await realpath(notesDirectory);
          }

          switch (call.name) {
            case "read_note":
              return readResult(root, call.path, toolBytes, signal);
            case "search_notes":
              if (selected !== undefined && selected !== null)
                return selectedSearch(root, selected, call.query, toolBytes, signal);

              return searchResult(root, call.query, toolBytes, signal);
            case "save_note":
              return saveResult(root, call, toolBytes);
          }
        },
        catch: (cause) =>
          cause instanceof AgentError
            ? cause
            : call.name !== "save_note" && Schema.is(MissingFile)(cause)
              ? new AgentError({
                  reason: "tool-arguments",
                  message: "The note does not exist. Use search_notes to find its path.",
                })
              : new AgentError({
                  reason: "tool-storage",
                  message: "Poppet could not read, search or save the note.",
                }),
      });

    return { execute };
  }),
);
