import { updateConfigFile } from "@poppet/config";
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

/**
 * Asks which gateway's home conversation receives approval prompts for
 * scheduled tasks without a destination, once two or more stay configured.
 */
const promptHomeGateway = (
  states: ReadonlyArray<GatewayState>,
  active: ReadonlySet<string>,
  saved: string | undefined,
) =>
  Effect.gen(function* () {
    const choices = states.filter(({ id }) => active.has(id));

    const stale =
      saved !== undefined && states.some(({ id }) => id === saved) && !active.has(saved);

    if (choices.length < 2) {
      return stale ? { id: null, name: "", summary: "cleared" } : null;
    }

    const id = yield* Prompt.Select({
      message: "Home gateway for approval prompts from scheduled tasks without a destination",
      choices: choices.map((gateway) => ({
        title: gateway.name,
        value: gateway.id,
        selected: gateway.id === saved,
      })),
    });

    const name = choices.find((gateway) => gateway.id === id)?.name ?? id;

    return { id, name, summary: id === saved ? `${name} (unchanged)` : name };
  });

export const promptGateways = (states: ReadonlyArray<GatewayState>, home: string | undefined) =>
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
    const active = new Set<string>();

    for (const gateway of states) {
      const picked = chosen.includes(gateway.id);
      const prompted = picked ? yield* gateway.setup.prompt : null;

      const removed =
        !picked &&
        gateway.configured &&
        (yield* Prompt.Confirm({
          message: `Remove the saved ${gateway.name} settings and tokens? No keeps them.`,
          initial: false,
        }));

      if (prompted !== null || (gateway.configured && !removed)) {
        active.add(gateway.id);
      }

      const save = removed
        ? {
            summary: "remove saved settings and tokens",
            save: gateway.setup.remove.pipe(Effect.provideService(GatewayEnvironment, environment)),
          }
        : prompted;

      saves.push({ name: gateway.name, draft: save });
    }

    const homeGateway = yield* promptHomeGateway(states, active, home);

    if (homeGateway !== null) {
      saves.push({
        name: "Home gateway",
        draft: {
          summary: homeGateway.summary,
          save: updateConfigFile(environment.dataDirectory, ({ homeGateway: _old, ...file }) =>
            homeGateway.id === null ? file : { ...file, homeGateway: homeGateway.id },
          ).pipe(
            Effect.as(
              homeGateway.id === null
                ? "Cleared the home gateway."
                : `Saved home gateway ${homeGateway.name}.`,
            ),
          ),
        },
      });
    }

    return saves;
  });
