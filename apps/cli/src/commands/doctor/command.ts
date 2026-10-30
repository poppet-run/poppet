import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { collectDoctor } from "#src/commands/doctor/collect";
import { renderDoctor } from "#src/commands/doctor/report";
import { booleanFlag } from "#src/commands/flags";

export const doctorCommand = (context: CLIContext) =>
  Command.make(
    "doctor",
    {
      json: booleanFlag("json", "Print versioned JSON inspection results"),
    },
    ({ json }) =>
      Effect.gen(function* () {
        const report = yield* collectDoctor(context);
        yield* Console.log(json ? JSON.stringify(report, null, 2) : renderDoctor(report));
        process.exitCode = report.exitCode;
      }),
  ).pipe(
    Command.withDescription(
      "Inspect local setup and saved worker state without repairs or live probes",
    ),
  );
