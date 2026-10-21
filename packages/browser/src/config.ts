import { isAbsolute, resolve } from "node:path";

import { Config, ConfigProvider, Effect, Schema } from "effect";

const Executable = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => !value.includes("\0")),
);

const Domain = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  ),
);

/** Browser access uses owner-selected hostnames, or "*" for all HTTP(S) hosts. */
export const BrowserSettings = Schema.Struct({
  enabled: Schema.Boolean,
  command: Schema.optionalKey(Executable),
  chromiumExecutable: Schema.optionalKey(Executable),
  allowedDomains: Schema.optionalKey(
    Schema.Array(Schema.Union([Domain, Schema.Literal("*")])).check(Schema.isMaxLength(32)),
  ),
}).check(
  Schema.makeFilter((settings) =>
    !settings.enabled ||
    (settings.chromiumExecutable !== undefined &&
      isAbsolute(settings.chromiumExecutable) &&
      (settings.allowedDomains?.length ?? 0) > 0)
      ? true
      : "Enabled browser access requires an absolute chromiumExecutable and nonempty allowedDomains.",
  ),
);

export type BrowserSettings = typeof BrowserSettings.Type;

/** An environment override replaces the complete browser configuration. */
export const browserSettings = Config.String("POPPET_BROWSER").pipe(
  Config.withDefault('{"enabled":false}'),
  Effect.flatMap((json) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserSettings), {
      onExcessProperty: "error",
    })(json),
  ),
  Effect.mapError(
    () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({ message: "Invalid POPPET_BROWSER. See docs/browser.md." }),
      ),
  ),
);

/** File-configured executable paths resolve beside config.json; bare command names use PATH. */
export const browserFileValue = (settings: BrowserSettings | undefined, directory: string) =>
  settings === undefined
    ? undefined
    : JSON.stringify(
        settings.command?.includes("/")
          ? { ...settings, command: resolve(directory, settings.command) }
          : settings,
      );
