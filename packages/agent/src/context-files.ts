import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { isMissingFile, openNoFollow, readFileBounded } from "@poppet/io";
import { SkillName, SkillSnapshot } from "@poppet/store";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";

const maxBytes = 8192;

const invalid = () =>
  new AgentError({
    reason: "invalid-request",
    message:
      "Skills must be UTF-8 SKILL.md files of at most 8192 bytes in named directories under <data directory>/skills. Symlinks, hard links, and paths are not allowed.",
  });

const failure = (cause: unknown) => (cause instanceof AgentError ? cause : invalid());

const directoryInfo = async (path: string) => {
  const info = await lstat(path);

  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw invalid();

  return info;
};

export const contextFiles = Effect.gen(function* () {
  const { dataDirectory } = yield* AppConfig;
  // Canonicalize the configured parent, but never follow a link at the context root or below it.
  const rootPath = async () => join(await realpath(dataDirectory), "skills");

  const read = (name: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        Schema.decodeUnknownSync(SkillName)(name);
        signal.throwIfAborted();
        const root = await rootPath();
        await directoryInfo(root);
        const parent = join(root, name);
        const original = await directoryInfo(parent);
        const path = join(parent, "SKILL.md");

        const handle = await openNoFollow(path);

        if (handle === null) throw invalid();

        try {
          const info = await handle.stat();

          if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw invalid();
          const buffer = await readFileBounded(handle, maxBytes, invalid, signal);
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
            new TextDecoder("utf-8", { fatal: true }).decode(buffer),
          );
        } finally {
          await handle.close();
        }
      },
      catch: failure,
    });

  const list = Effect.tryPromise({
    try: async (signal) => {
      const root = await rootPath().catch((cause: unknown) => {
        if (isMissingFile(cause)) return null;
        throw cause;
      });

      if (root === null) return [];

      const info = await lstat(root).catch((cause: unknown) => {
        if (isMissingFile(cause)) return null;
        throw cause;
      });

      if (info === null) return [];
      await directoryInfo(root);
      const names: string[] = [];
      let visited = 0;

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

      return names.toSorted();
    },
    catch: failure,
  });

  const load = (name: string) => read(name).pipe(Effect.map((content) => ({ name, content })));

  return { list, load };
});
