import { GatewayEnvironment } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import { Effect, Result } from "effect";
import { Prompt } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export interface GatewayState {
  readonly id: string;
  readonly name: string;
  readonly setup: GatewayPromptSetup;
  readonly configured: boolean;
  /** Why the saved settings cannot be read, or null when they can. */
  readonly unreadable: string | null;
}

export const gatewayStates = (context: CLIContext) =>
  Effect.forEach(
    context.gateways.flatMap(({ id, name, promptSetup }) =>
      promptSetup === undefined ? [] : [{ id, name, setup: promptSetup }],
    ),
    (gateway) =>
      gateway.setup.configured.pipe(
        Effect.result,
        Effect.map((loaded) => ({
          ...gateway,
          configured: Result.isSuccess(loaded) && loaded.success,
          unreadable: Result.isFailure(loaded) ? loaded.failure.message : null,
        })),
      ),
  );

export const describeGateways = (states: ReadonlyArray<GatewayState>) =>
  states.length === 0
    ? "none available"
    : states
        .map(
          (gateway) =>
            `${gateway.name} ${gateway.unreadable === null ? (gateway.configured ? "configured" : "not configured") : "unreadable"}`,
        )
        .join(", ");

export const promptGateways = (states: ReadonlyArray<GatewayState>) =>
  Effect.gen(function* () {
    const chosen = yield* Prompt.MultiSelect({
      message: "Messaging gateways to set up (space toggles, enter confirms)",
      choices: states.map((gateway) => ({
        title: `${gateway.name}${gateway.configured ? " (configured)" : ""}${gateway.unreadable === null ? "" : " (unreadable, setup replaces it)"}`,
        value: gateway.id,
        selected: gateway.configured,
      })),
    });

    const environment = yield* GatewayEnvironment;
    const saves = [];

    for (const gateway of states) {
      const picked = chosen.includes(gateway.id);
      const prompted = picked ? yield* gateway.setup.prompt : null;

      const removed =
        !picked &&
        (gateway.configured || gateway.unreadable !== null) &&
        (yield* Prompt.Confirm({
          message: `Remove the saved ${gateway.name} settings and tokens? No keeps them.`,
          initial: false,
        }));

      const save = removed
        ? {
            summary: "remove saved settings and tokens",
            save: gateway.setup.remove.pipe(Effect.provideService(GatewayEnvironment, environment)),
          }
        : prompted;

      saves.push({ name: gateway.name, draft: save });
    }

    return saves;
  });
