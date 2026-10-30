import { Store } from "@poppet/store";
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { fields, printParsed } from "#src/output";

const StoreStatus = Schema.Struct({
  path: Schema.String,
  schemaVersion: Schema.Number,
  sessions: Schema.Number,
  messages: Schema.Number,
  runs: Schema.Number,
});

const renderStatus = (status: typeof StoreStatus.Type) =>
  fields([
    ["Path", status.path],
    ["Schema version", String(status.schemaVersion)],
    ["Sessions", String(status.sessions)],
    ["Messages", String(status.messages)],
    ["Runs", String(status.runs)],
  ]);

export const storeCommand = (context: CLIContext) => {
  const { runtime, queryWorker } = context;

  return Command.make("store").pipe(
    Command.withDescription("Inspect the conversation store"),
    Command.withSubcommands([
      Command.make("status", { json: jsonFlag }, ({ json }) =>
        queryWorker(
          { kind: "store" },
          Store.use((store) => store.status).pipe(Effect.provide(runtime.store)),
        ).pipe(Effect.flatMap((status) => printParsed(json, status, StoreStatus, renderStatus))),
      ).pipe(Command.withDescription("Open/migrate the conversation store and show counts")),
    ]),
  );
};
