import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discord } from "@poppet/channel-discord/registration";
import { slack } from "@poppet/channel-slack/registration";
import { ConfigSourceLive, dataDirectory, gatewayPackages } from "@poppet/config";
import { ChannelError } from "@poppet/gateway";
import type { ChannelRegistration } from "@poppet/gateway";
import { Effect, Predicate, Schema } from "effect";

import { validateChannels } from "#src/commands/gateway/channels";

export const channels: ReadonlyArray<ChannelRegistration> = [discord, slack];

const Registration = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  setupHelp: Schema.NonEmptyString,
  setup: Schema.declare((value): value is ChannelRegistration["setup"] =>
    Predicate.isFunction(value),
  ),
  load: Schema.declare((value): value is ChannelRegistration["load"] => Effect.isEffect(value)),
});

const packageEntry =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

const protectedEntry = async (path: string, directory: boolean) => {
  const info = await lstat(path);

  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error("Gateway package paths must be owner-controlled.");
  }
};

const gatewayModule = async (directory: string, entry: string) => {
  if (!packageEntry.test(entry)) {
    throw new Error("Invalid package entry point");
  }

  const gateways = join(directory, "gateways");
  await protectedEntry(gateways, true);
  const root = await realpath(gateways);
  const modules = join(root, "node_modules");
  await protectedEntry(modules, true);

  const base = pathToFileURL(join(root, "package.json")).href;
  const resolved = import.meta.resolve(entry, base);
  const path = await realpath(resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved);
  const entryPath = relative(modules, path);

  if (!entryPath || isAbsolute(entryPath) || entryPath === ".." || entryPath.startsWith("../")) {
    throw new Error("Gateway package is outside the install directory.");
  }

  const parents: Array<string> = [];

  for (let parent = dirname(path); parent !== modules; parent = dirname(parent)) {
    parents.push(parent);
  }

  await Promise.all([
    ...parents.map((parent) => protectedEntry(parent, true)),
    protectedEntry(path, false),
  ]);

  return pathToFileURL(path).href;
};

export const loadRegisteredChannels = Effect.gen(function* () {
  const directory = yield* dataDirectory;
  const entries = yield* gatewayPackages;
  const registered = [...channels];

  for (const entry of entries) {
    const registration = yield* Effect.tryPromise({
      try: async () => {
        const module: unknown = await import(await gatewayModule(directory, entry));

        const { default: loaded } = Schema.decodeUnknownSync(
          Schema.Struct({ default: Registration }),
        )(module);

        return loaded;
      },
      catch: () =>
        new ChannelError({
          reason: "configuration",
          message: `Cannot load gateway package ${entry}. Install it in ${join(directory, "gateways")} and export a default ChannelRegistration.`,
        }),
    });

    registered.push(registration);
  }

  yield* Effect.try({
    try: () => validateChannels(registered),
    catch: (cause) =>
      new ChannelError({
        reason: "configuration",
        message: cause instanceof Error ? cause.message : "Invalid gateway registrations.",
      }),
  });

  return registered;
}).pipe(Effect.provide(ConfigSourceLive));
