/* eslint-disable no-await-in-loop -- Reads stay bounded and check cancellation between filesystem operations. */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { SkillName, SkillSnapshot } from "@poppet/store";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const maxBytes = 8192;

const invalid = () =>
  new AgentError({
    reason: "invalid-request",
    message:
      "Skills must be UTF-8 SKILL.md files and projects must be UTF-8 PROJECT.md/context files of at most 8192 bytes in named directories under <data directory>/skills, $HOME/.agent/skills, or <data directory>/projects. Symlinks, hard links, and paths are not allowed.",
  });

const failure = (cause: unknown) => (cause instanceof AgentError ? cause : invalid());

const directoryInfo = async (path: string) => {
  const info = await lstat(path);

  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw invalid();

  return info;
};

export const contextFiles = (
  collection: "skills" | "projects",
  filename: "SKILL.md" | "PROJECT.md",
  fallbackDirectory?: string,
) =>
  Effect.gen(function* () {
    const { dataDirectory } = yield* AppConfig;

    // Canonicalize the configured parent, but never follow a link at the context root or below it.
    const rootPaths = async () => {
      const roots: string[] = [];

      for (const directory of [dataDirectory, ...(fallbackDirectory ? [fallbackDirectory] : [])]) {
        const parent = await realpath(directory).catch((cause: unknown) => {
          if (Schema.is(MissingFile)(cause)) return null;
          throw cause;
        });

        if (parent !== null) roots.push(join(parent, collection));
      }

      return roots;
    };

    const findRoot = async (name: string) => {
      for (const root of await rootPaths()) {
        const exists = await lstat(root).catch((cause: unknown) => {
          if (Schema.is(MissingFile)(cause)) return null;
          throw cause;
        });

        if (exists === null) continue;
        await directoryInfo(root);

        const entry = await lstat(join(root, name)).catch((cause: unknown) => {
          if (Schema.is(MissingFile)(cause)) return null;
          throw cause;
        });

        if (entry !== null) return root;
      }

      throw invalid();
    };

    const read = (name: string, file: "SKILL.md" | "PROJECT.md" | "notes.json", optional = false) =>
      Effect.tryPromise({
        try: async (signal) => {
          Schema.decodeUnknownSync(SkillName)(name);
          signal.throwIfAborted();
          const root = await findRoot(name);
          await directoryInfo(root);
          const parent = join(root, name);
          const original = await directoryInfo(parent);
          const path = join(parent, file);

          const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          ).catch((cause: unknown) => {
            if (optional && Schema.is(MissingFile)(cause)) return null;
            throw cause;
          });

          if (handle === null) return null;

          try {
            const info = await handle.stat();

            if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw invalid();
            const buffer = Buffer.alloc(maxBytes + 1);
            let length = 0;

            while (length < buffer.length) {
              signal.throwIfAborted();
              const result = await handle.read(buffer, length, buffer.length - length, length);

              if (result.bytesRead === 0) break;
              length += result.bytesRead;
            }

            if (length > maxBytes) throw invalid();
            await directoryInfo(root);
            const current = await directoryInfo(parent);
            const target = await lstat(path);

            if (
              current.dev !== original.dev ||
              current.ino !== original.ino ||
              target.dev !== info.dev ||
              target.ino !== info.ino ||
              target.nlink !== 1 ||
              target.isSymbolicLink()
            )
              throw invalid();
            signal.throwIfAborted();

            return Schema.decodeUnknownSync(SkillSnapshot.fields.content)(
              new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
            );
          } finally {
            await handle.close();
          }
        },
        catch: failure,
      });

    const list = Effect.tryPromise({
      try: async (signal) => {
        const names: string[] = [];
        let visited = 0;

        for (const root of await rootPaths()) {
          const info = await lstat(root).catch((cause: unknown) => {
            if (Schema.is(MissingFile)(cause)) return null;
            throw cause;
          });

          if (info === null) continue;
          await directoryInfo(root);

          for await (const entry of await opendir(root)) {
            signal.throwIfAborted();

            if (++visited > 1000)
              throw new AgentError({
                reason: "invalid-request",
                message: "The context directory exceeds the 1000 entry listing limit.",
              });

            if (entry.isDirectory() && !entry.isSymbolicLink() && Schema.is(SkillName)(entry.name))
              names.push(entry.name);
          }
        }

        return [...new Set(names)].toSorted();
      },
      catch: failure,
    });

    const load = (name: string) =>
      read(name, filename).pipe(
        Effect.flatMap((content) =>
          content === null ? Effect.fail(invalid()) : Effect.succeed({ name, content }),
        ),
      );

    return { list, load, read };
  });
