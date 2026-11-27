import { GatewayEnvironment } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import { Effect } from "effect";
import { Prompt } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export interface GatewayState {
  readonly id: string;
  readonly name: string;
  readonly setup: GatewayPromptSetup;
  readonly configured: boolean;
}

export const gatewayStates = (context: CLIContext) =>
  Effect.forEach(
    context.gateways.flatMap(({ id, name, promptSetup }) =>
      promptSetup === undefined ? [] : [{ id, name, setup: promptSetup }],
    ),
    (gateway) =>
      gateway.setup.configured.pipe(Effect.map((configured) => ({ ...gateway, configured }))),
  );

export const describeGateways = (states: ReadonlyArray<GatewayState>) =>
  states.length === 0
    ? "none available"
    : states
        .map((gateway) => `${gateway.name} ${gateway.configured ? "configured" : "not configured"}`)
        .join(", ");

export const promptGateways = (states: ReadonlyArray<GatewayState>) =>
  Effect.gen(function* () {
    const chosen = yield* Prompt.MultiSelect({
      message: "Messaging gateways to set up (space toggles, enter confirms)",
      choices: states.map((gateway) => ({
        title: gateway.configured ? `${gateway.name} (configured)` : gateway.name,
        value: gateway.id,
        selected: gateway.configured,
      })),
    });

    const environment = yield* GatewayEnvironment;
    const saves = [];

    for (const gateway of states) {
      const save = chosen.includes(gateway.id)
        ? yield* gateway.setup.prompt
        : gateway.configured &&
            (yield* Prompt.Confirm({
              message: `Remove the saved ${gateway.name} settings and tokens? No keeps them.`,
              initial: false,
            }))
          ? {
              summary: "remove saved settings and tokens",
              save: gateway.setup.remove.pipe(
                Effect.provideService(GatewayEnvironment, environment),
              ),
            }
          : null;

      saves.push({ name: gateway.name, draft: save });
    }

    return saves;
  });
