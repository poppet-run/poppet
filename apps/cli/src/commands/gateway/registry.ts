import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigSourceLive, dataDirectory, gatewayPackages } from "@poppet/config";
import { GatewayError } from "@poppet/gateway";
import type { GatewayRegistration } from "@poppet/gateway";
import { discord } from "@poppet/gateway-discord/registration";
import { slack } from "@poppet/gateway-slack/registration";
import { telegram } from "@poppet/gateway-telegram/registration";
import { Effect, Predicate, Schema } from "effect";

import { validateGateways } from "#src/commands/gateway/gateways";

export const gateways: ReadonlyArray<GatewayRegistration> = [discord, slack, telegram];

const Registration = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  setupHelp: Schema.NonEmptyString,
  setup: Schema.declare((value): value is GatewayRegistration["setup"] =>
    Predicate.isFunction(value),
  ),
  load: Schema.declare((value): value is GatewayRegistration["load"] => Effect.isEffect(value)),
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

export const loadRegisteredGateways = Effect.gen(function* () {
  const directory = yield* dataDirectory;
  const entries = yield* gatewayPackages;
  const registered = [...gateways];

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
        new GatewayError({
          reason: "configuration",
          message: `Cannot load gateway package ${entry}. Install it in ${join(directory, "gateways")} and export a default GatewayRegistration.`,
        }),
    });

    registered.push(registration);
  }

  yield* Effect.try({
    try: () => validateGateways(registered),
    catch: (cause) =>
      new GatewayError({
        reason: "configuration",
        message: cause instanceof Error ? cause.message : "Invalid gateway registrations.",
      }),
  });

  return registered;
}).pipe(Effect.provide(ConfigSourceLive));
