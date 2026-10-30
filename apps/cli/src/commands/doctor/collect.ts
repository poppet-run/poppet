import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import { ChatSettings, ChatSettingsLive } from "@poppet/agent";
import {
  browserExecutables,
  browserInstallationVersions,
  agentBrowserCompatibility,
  chromiumCompatibility,
  BrowserError,
} from "@poppet/browser";
import {
  AppConfig,
  browserSettings,
  ConfigIdentity,
  ConfigSource,
  ConfigSourceLive,
  dataDirectory,
  gatewayPackages,
  taskCatchUpMinutes,
  webSearchEnabled,
  webSearchProvider,
} from "@poppet/config";
import { readBoundedText } from "@poppet/io";
import { mcpServers } from "@poppet/mcp";
import { requestWorker, workerSocketPath } from "@poppet/worker";
import { Effect, Layer, Match, Result, Schema } from "effect";

import type { CLIContext } from "#src/commands/context";
import {
  inspectAuthentication,
  inspectContext,
  inspectService,
  fileInfo,
} from "#src/commands/doctor/local";
import {
  DoctorSnapshot,
  doctorReport,
  finding,
  unavailable,
  type DoctorCheck,
} from "#src/commands/doctor/report";

/** Keep errors opaque: config parse failures and auth causes can contain secrets. */
export const inspectCheck = <E, R>(
  id: string,
  next: string,
  effect: Effect.Effect<DoctorCheck, E, R>,
) =>
  effect.pipe(
    Effect.timeout("2 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.succeed(
        unavailable(
          id,
          next,
          "This check did not finish within two seconds. Try running doctor again.",
        ),
      ),
    ),
    Effect.catchCause(() => Effect.succeed(unavailable(id, next))),
  );

const savedChecks = ["tasks", "provider-holds", "delivery"];

const noSnapshot = (message: string) =>
  savedChecks.map((id) =>
    finding(
      id,
      "error",
      "not-checked",
      message,
      "Run poppet worker status and poppet worker logs to check why the worker is unavailable.",
      true,
    ),
  );

const inspectWorker = (directory: string, identity: string | null) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(async (signal) => {
      const reply = await requestWorker(
        workerSocketPath(directory),
        "/v1/doctor",
        { version: 1 },
        signal,
      );

      if (reply === null) return null;

      if (!reply.ok || reply.body === null) {
        await reply.body?.cancel();

        return { unsupported: true as const };
      }

      const text = await readBoundedText(
        reply.body,
        32768,
        () => new Error("Worker response limit"),
      );

      return Schema.decodeUnknownSync(Schema.fromJsonString(DoctorSnapshot))(text);
    }).pipe(Effect.timeout("2 seconds"), Effect.result);

    if (Result.isFailure(response))
      return [
        unavailable("worker.socket", "Run poppet worker status and poppet worker logs."),
        ...noSnapshot(
          "Doctor could not get a report from the worker, so it could not check these saved records.",
        ),
      ];

    if (response.success === null) {
      const database = yield* Effect.tryPromise(() =>
        fileInfo(join(directory, "store", "poppet.sqlite")),
      );

      return [
        finding(
          "worker.socket",
          "warning",
          "local",
          "The worker is not responding. It may be stopped, still starting, or failing to start.",
          "Run poppet worker status and poppet worker logs. If it is stopped, run poppet worker start or poppet worker run.",
        ),
        ...(database === null
          ? savedChecks.map((id) =>
              finding(id, "skipped", "local", "There is no saved database to check yet."),
            )
          : noSnapshot(
              "Doctor needs a responding worker to check these saved records. It left your database untouched.",
            )),
      ];
    }

    if ("unsupported" in response.success)
      return [
        finding("worker.socket", "ok", "local", "The worker is responding."),
        ...noSnapshot(
          "The worker responded but could not provide this report. It may need restarting after an update.",
        ),
      ];
    const snapshot = response.success;

    if (identity === null || identity !== snapshot.identity)
      return [
        finding(
          "worker.identity",
          "warning",
          "worker",
          "Doctor could not match your current settings to the settings the worker loaded at startup.",
          "Check poppet config. If you changed settings, run poppet worker restart to load them.",
        ),
        ...noSnapshot(
          "Doctor could not confirm which settings the worker is using, so it did not use the worker's report.",
        ),
      ];
    const tasks = snapshot.tasks;
    const problem = tasks.failed + tasks.interrupted > 0;
    const delivery = snapshot.delivery;
    const deliveryProblem = delivery.failed + delivery.uncertain > 0;

    const checks = [
      finding(
        "worker.socket",
        "ok",
        "worker",
        "The worker is responding and is using the same settings as this command.",
      ),
      finding(
        "tasks",
        problem ? "warning" : "ok",
        "worker",
        [
          `${tasks.failed} failed and ${tasks.interrupted} interrupted task runs in the last 24 hours. ${tasks.running} currently running.`,
          `Next scheduled run: ${tasks.nextAt === null ? "none" : new Date(tasks.nextAt).toISOString()}.`,
          ...(tasks.running > 0 ? ["Doctor cannot tell whether a running task is stuck."] : []),
          ...(snapshot.recent ?? []).map(
            (item) => `${item.status}: task ${item.jobId}, run ${item.id}.`,
          ),
          ...(tasks.failed + tasks.interrupted > (snapshot.recent?.length ?? 0)
            ? [
                `${tasks.failed + tasks.interrupted - (snapshot.recent?.length ?? 0)} more failed or interrupted runs not shown.`,
              ]
            : []),
        ].join(" "),
        problem
          ? "Run poppet tasks status to review failed or interrupted runs before retrying."
          : null,
      ),
      finding(
        "provider-holds",
        snapshot.holds.length > 0 ? "warning" : "ok",
        "worker",
        snapshot.holds.length === 0
          ? "No providers have paused scheduled work."
          : [
              ...snapshot.holds.map((hold) => {
                const reason = Match.value(hold.reason).pipe(
                  Match.when("quota", () => "a usage limit was reached"),
                  Match.when("rate-limit", () => "too many requests were sent"),
                  Match.when("temporary", () => "the provider had a temporary problem"),
                  Match.when("other", () => "the provider reported a problem"),
                  Match.exhaustive,
                );

                return `${hold.provider} is paused because ${reason}. ${hold.resumeAt === null ? "Waiting for you to resume work." : `Scheduled work can retry at ${new Date(hold.resumeAt).toISOString()}.`}`;
              }),
              ...(snapshot.holdsOmitted > 0
                ? [`${snapshot.holdsOmitted} more paused providers not shown.`]
                : []),
            ].join(" "),
        snapshot.holds.length > 0
          ? "Run poppet tasks status. Wait until the retry time, or use poppet tasks resume-provider with the provider ID once its limit is cleared."
          : null,
      ),
      finding(
        "delivery",
        deliveryProblem ? "warning" : "ok",
        "worker",
        `${delivery.pending} messages waiting to send, ${delivery.failed} failed sends, ${delivery.uncertain} sends with unknown delivery status.`,
        deliveryProblem
          ? "Run poppet gateway status. Check the destination for messages with unknown delivery status before retrying, to avoid duplicates."
          : null,
      ),
      snapshot.gateway === undefined
        ? unavailable(
            "gateway.connection",
            "Run poppet worker restart so doctor can check messaging connections.",
          )
        : finding(
            "gateway.connection",
            snapshot.gateway.disconnected + snapshot.gateway.configurationErrors > 0
              ? "warning"
              : snapshot.gateway.unknown > 0
                ? "skipped"
                : "ok",
            "worker",
            `${snapshot.gateway.enabled} messaging services enabled. ${snapshot.gateway.disconnected} report being disconnected, ${snapshot.gateway.configurationErrors} have setup problems, and ${snapshot.gateway.unknown} did not report a connection state. Doctor has not sent a test message.`,
            snapshot.gateway.disconnected + snapshot.gateway.configurationErrors > 0
              ? "Run poppet gateway status and poppet worker logs."
              : null,
          ),
    ];

    return checks.map((check) => Object.assign(check, { observedAt: snapshot.observedAt }));
  });

export const collectDoctor = (context: CLIContext, service = inspectService) =>
  Effect.gen(function* () {
    const selected = yield* dataDirectory.pipe(Effect.result);

    if (Result.isFailure(selected))
      return doctorReport(
        [
          unavailable(
            "configuration",
            "Set POPPET_DATA_DIR to a valid directory and run poppet doctor again.",
          ),
        ],
        null,
      );
    const directory = selected.success;
    const checks: DoctorCheck[] = [];

    const configuration = yield* Effect.gen(function* () {
      const config = yield* AppConfig;
      const source = yield* ConfigSource;
      yield* ChatSettings;
      yield* Effect.all([taskCatchUpMinutes, webSearchEnabled, webSearchProvider, gatewayPackages]);

      return {
        config,
        source,
        browser: yield* browserSettings,
        servers: yield* mcpServers,
        identity: yield* ConfigIdentity,
      };
    }).pipe(
      Effect.provide([
        context.runtime.config,
        ChatSettingsLive.pipe(Layer.provide(ConfigSourceLive)),
      ]),
      Effect.timeout("2 seconds"),
      Effect.result,
    );

    const basic = [
      inspectCheck(
        "installation",
        "Run poppet setup or select an existing POPPET_DATA_DIR.",
        Effect.tryPromise(async () => {
          const info = await fileInfo(directory);

          if (info === null)
            return finding(
              "installation",
              "warning",
              "local",
              "This data directory does not exist yet. Doctor did not create it.",
              "Run poppet setup.",
            );

          if (!info.isDirectory()) throw new Error("Invalid directory");

          return finding("installation", "ok", "local", "Your data directory exists.");
        }),
      ),
      inspectCheck(
        "worker.service",
        "Run poppet worker status for details about the background service.",
        service(directory),
      ),
      inspectCheck(
        "context",
        "Check permissions and the 8 KiB size limit for profile.md and soul.md.",
        inspectContext(directory),
      ),
    ];

    if (Result.isSuccess(configuration)) {
      const { config, source, browser, servers } = configuration.success;
      checks.push(
        finding(
          "configuration",
          "ok",
          "local",
          `Using ${source.configFile.exists ? "valid settings from config.json" : "default settings because config.json is absent"}. Provider: ${config.provider}.`,
        ),
      );
      basic.push(
        inspectCheck(
          "authentication",
          "Check that the auth directory and credential files belong to you and are private. Use poppet provider login if you need to sign in again.",
          inspectAuthentication(
            directory,
            context.registered.find((provider) => provider.id === config.provider)!,
          ),
        ),
      );
      basic.push(
        inspectCheck(
          "browser",
          "Check browser.command and browser.chromiumExecutable in config.json. See docs/browser.md for installation steps.",
          Effect.tryPromise(async () => {
            if (!browser.enabled)
              return finding("browser", "skipped", "local", "Browser access is disabled.");

            // Discovery errors from this helper contain only fixed installation guidance.
            // OS errors stay opaque because they can contain configured paths.
            const paths = await browserExecutables(browser).catch((cause: unknown) =>
              cause instanceof BrowserError ? cause : null,
            );

            if (paths === null)
              return unavailable(
                "browser",
                "Install the browser programs or set browser.command and browser.chromiumExecutable in config.json. See docs/browser.md.",
                "Doctor could not locate agent-browser or its Chrome for Testing installation.",
              );

            if (paths instanceof BrowserError)
              return unavailable(
                "browser",
                "Check the browser installation described in docs/browser.md.",
                paths.message,
              );

            const programs = [
              { name: "agent-browser", setting: "browser.command", path: paths.executable },
              {
                name: "Chrome for Testing",
                setting: "browser.chromiumExecutable",
                path: paths.chromium,
              },
            ];

            const programChecks = await Promise.all(
              programs.map(async (program) => {
                const usable = await stat(program.path)
                  .then(async (info) => {
                    if (!info.isFile()) return false;
                    await access(program.path, constants.X_OK);

                    return true;
                  })
                  .catch(() => false);

                return Object.assign(program, { usable });
              }),
            );

            const missing = programChecks.find((program) => !program.usable);

            if (missing !== undefined)
              return unavailable(
                "browser",
                `Check ${missing.setting} in config.json. Make sure it points to an installed program that your user can run.`,
                `${missing.name} is missing, is not a regular file, or cannot be run by your user.`,
              );

            const versions = await browserInstallationVersions(paths);

            const compatibility = [
              versions.agentBrowser === null
                ? null
                : agentBrowserCompatibility(versions.agentBrowser),
              versions.chromium === null ? null : chromiumCompatibility(versions.chromium),
            ];

            const unsupported = compatibility.some((entry) => entry?.status === "unsupported");

            const uncertain = compatibility.some(
              (entry) => entry === null || entry.status === "untested",
            );

            const status = unsupported ? "error" : uncertain ? "warning" : "ok";

            return finding(
              "browser",
              status,
              "saved",
              [
                "Browser programs were found. Saved installation details show:",
                versions.agentBrowser === null
                  ? "agent-browser version is unknown."
                  : `agent-browser ${versions.agentBrowser}.`,
                versions.chromium === null
                  ? "Chrome for Testing version is unknown."
                  : `Chrome for Testing ${versions.chromium}.`,
                ...compatibility.flatMap((entry) =>
                  entry !== null && entry.status !== "supported" ? [entry.message] : [],
                ),
                "Doctor has not run either program. Poppet checks their versions before the first browser action.",
              ].join(" "),
              unsupported
                ? "Install a supported agent-browser version. See docs/browser.md."
                : uncertain
                  ? "See docs/browser.md for supported versions. If a version is unknown, Poppet will check it when you use the browser."
                  : null,
            );
          }),
        ),
      );
      basic.push(
        inspectCheck(
          "mcp",
          "Run poppet mcp servers and check enabled commands and permissions.",
          Effect.sync(() => {
            const enabled = servers.filter((server) => server.enabled);

            if (enabled.length === 0)
              return finding("mcp", "skipped", "local", "No MCP servers are enabled.");

            const missing = enabled.some(
              (server) =>
                "command" in server &&
                Bun.which(server.command, { cwd: server.cwd ?? process.cwd() }) === null,
            );

            return finding(
              "mcp",
              missing ? "warning" : "ok",
              "local",
              missing
                ? "Doctor could not find a program needed by an enabled MCP server."
                : "Enabled MCP servers have valid settings and tool permissions. Doctor has not started the servers or tested their sign-in details or tools.",
              missing ? "Check mcpServers commands in config.json." : null,
            );
          }),
        ),
      );
    } else {
      checks.push(
        finding(
          "configuration",
          "error",
          "local",
          "Doctor could not read or validate config.json. Some settings may be invalid, or the file may be unreadable.",
          "Check config.json against docs/configuration.md.",
          true,
        ),
      );
      checks.push(
        ...["authentication", "browser", "mcp"].map((id) =>
          finding(
            id,
            "skipped",
            "not-checked",
            "Doctor needs valid settings before it can check this.",
          ),
        ),
      );
    }

    checks.push(...(yield* Effect.all(basic, { concurrency: "unbounded" })));

    const worker = yield* inspectWorker(
      directory,
      Result.isSuccess(configuration) ? configuration.success.identity : null,
    ).pipe(
      Effect.timeout("2 seconds"),
      Effect.catchCause(() =>
        Effect.succeed([
          unavailable("worker.socket", "Run poppet worker status."),
          ...noSnapshot("Doctor could not get a report from the worker."),
        ]),
      ),
    );

    checks.push(...worker);

    return doctorReport(checks, directory);
  });
