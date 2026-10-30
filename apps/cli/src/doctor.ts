import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import { ChatSettings, ChatSettingsLive } from "@poppet/agent";
import { browserExecutables } from "@poppet/browser";
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
import { Effect, Layer, Result, Schema } from "effect";

import type { CLIContext } from "#src/commands/context";
import { inspectAuthentication, inspectContext, inspectService, fileInfo } from "#src/doctor-local";
import {
  DoctorSnapshot,
  doctorReport,
  finding,
  unavailable,
  type DoctorCheck,
} from "#src/doctor-report";

/** Keep errors opaque: config parse failures and auth causes can contain secrets. */
export const inspectCheck = <E, R>(
  id: string,
  next: string,
  effect: Effect.Effect<DoctorCheck, E, R>,
) =>
  effect.pipe(
    Effect.timeout("2 seconds"),
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
      "Run poppet worker status; start or update the worker to inspect saved work.",
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
        ...noSnapshot("Worker inspection failed; no local database was opened."),
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
          "No worker is reachable on the protected socket.",
          "Run poppet worker start, or poppet worker run for foreground use.",
        ),
        ...(database === null
          ? savedChecks.map((id) => finding(id, "skipped", "local", "No saved database exists."))
          : noSnapshot(
              "Offline SQLite inspection is unavailable without risking sidecar changes; the database was not opened.",
            )),
      ];
    }

    if ("unsupported" in response.success)
      return [
        finding("worker.socket", "ok", "local", "Worker socket is reachable."),
        ...noSnapshot("Worker does not support this inspection or could not complete it."),
      ];
    const snapshot = response.success;

    if (identity === null || identity !== snapshot.identity)
      return [
        finding(
          "worker.identity",
          "warning",
          "worker",
          "CLI configuration is invalid or differs from the running worker.",
          "Check poppet config and restart the worker with poppet worker restart.",
        ),
        ...noSnapshot(
          "Worker summaries were not combined with a different or invalid configuration.",
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
        "Worker is reachable and its startup configuration matches.",
      ),
      finding(
        "tasks",
        problem ? "warning" : "ok",
        "worker",
        `${tasks.failed} failed and ${tasks.interrupted} interrupted occurrences in the last 24 hours; ${tasks.running} running. Next due: ${tasks.nextAt === null ? "none" : new Date(tasks.nextAt).toISOString()}. Running work is not assumed stale.${(snapshot.recent ?? []).map((item) => ` ${item.status}: task ${item.jobId}, occurrence ${item.id}.`).join("")} ${Math.max(0, tasks.failed + tasks.interrupted - (snapshot.recent?.length ?? 0))} recent failure IDs omitted.`,
        problem ? "Run poppet tasks status to inspect failures before retrying." : null,
      ),
      finding(
        "provider-holds",
        snapshot.holds.length > 0 ? "warning" : "ok",
        "worker",
        `${snapshot.holds.length} saved holds; ${snapshot.holdsOmitted} omitted.${snapshot.holds.map((hold) => ` ${hold.provider}: ${hold.reason}: ${hold.resumeAt === null ? "owner action required" : `retry at ${new Date(hold.resumeAt).toISOString()}`}.`).join("")}`,
        snapshot.holds.length > 0
          ? "Run poppet tasks status; wait until the retry time or inspect quota before using poppet tasks resume-provider."
          : null,
      ),
      finding(
        "delivery",
        deliveryProblem ? "warning" : "ok",
        "worker",
        `${delivery.pending} pending, ${delivery.failed} failed, ${delivery.uncertain} uncertain sends. Delivery age is not stored.`,
        deliveryProblem
          ? "Run poppet gateway status. Inspect uncertain sends in the destination before retrying."
          : null,
      ),
      snapshot.gateway === undefined
        ? unavailable(
            "gateway.connection",
            "Restart the worker to load gateway observation support.",
          )
        : finding(
            "gateway.connection",
            snapshot.gateway.disconnected + snapshot.gateway.configurationErrors > 0
              ? "warning"
              : snapshot.gateway.unknown > 0
                ? "skipped"
                : "ok",
            "worker",
            `${snapshot.gateway.enabled} enabled adapters; ${snapshot.gateway.disconnected} disconnected; ${snapshot.gateway.configurationErrors} configuration failures; ${snapshot.gateway.unknown} unknown. These are local adapter observations, not a remote probe.`,
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
              "Data directory does not exist; nothing was created.",
              "Run poppet setup.",
            );

          if (!info.isDirectory()) throw new Error("Invalid directory");

          return finding("installation", "ok", "local", "Selected data directory exists.");
        }),
      ),
      inspectCheck(
        "worker.service",
        "Run poppet worker status to inspect the platform service.",
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
          `Validated ${source.configFile.exists ? "config.json" : "defaults; config.json is absent"}. Selected provider: ${config.provider}.`,
        ),
      );
      basic.push(
        inspectCheck(
          "authentication",
          "Check auth directory/file permissions and run poppet provider login.",
          inspectAuthentication(
            directory,
            context.registered.find((provider) => provider.id === config.provider)!,
          ),
        ),
      );
      basic.push(
        inspectCheck(
          "browser",
          "Check browser executables and domain policy in config.json; see docs/browser.md.",
          Effect.tryPromise(async () => {
            if (!browser.enabled)
              return finding("browser", "skipped", "local", "Browser access is disabled.");
            const paths = await browserExecutables(browser);
            await Promise.all(
              [paths.executable, paths.chromium].map(async (path) => {
                if (!(await stat(path)).isFile())
                  throw new Error("Executable is not a regular file");
                await access(path, constants.X_OK);
              }),
            );

            return finding(
              "browser",
              "ok",
              "local",
              "Browser executables are available and domain policy is valid. Binary versions and launch are unverified.",
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
                ? "An enabled MCP command is unavailable."
                : "Enabled MCP configuration and scheduled-tool allowlists are valid. Servers, credentials and tools were not exercised.",
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
          "Configuration is invalid or unreadable; values and parser errors are withheld.",
          "Check config.json against docs/configuration.md.",
          true,
        ),
      );
      checks.push(
        ...["authentication", "browser", "mcp"].map((id) =>
          finding(id, "skipped", "not-checked", "Requires valid configuration."),
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
          ...noSnapshot("Worker inspection is unavailable."),
        ]),
      ),
    );

    checks.push(...worker);

    return doctorReport(checks, directory);
  });
