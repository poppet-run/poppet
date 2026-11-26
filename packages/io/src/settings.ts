import { Config, Duration, Effect, Record, Schema } from "effect";

interface Setting {
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
}

const setting = (fallback: number, minimum: number, maximum: number): Setting => ({
  fallback,
  minimum,
  maximum,
});

const kib = 1024;
const mib = 1024 * kib;

export const timeoutSettings = {
  inferenceSeconds: setting(60, 5, 3600),
  providerRequestSeconds: setting(45, 5, 3600),
  modelCatalogSeconds: setting(30, 1, 300),
  modelCatalogCacheSeconds: setting(60, 0, 86_400),
  actionReviewSeconds: setting(30, 1, 600),
  sessionTitleSeconds: setting(10, 1, 300),
  conversationNamingSeconds: setting(10, 1, 300),
  pageFetchSeconds: setting(15, 1, 300),
  mcpConnectSeconds: setting(5, 1, 300),
  mcpStartupSeconds: setting(8, 1, 600),
  mcpToolCallSeconds: setting(10, 1, 3600),
  taskOperationSeconds: setting(8, 1, 300),
  approvalSeconds: setting(3600, 10, 86_400),
  attachmentDownloadSeconds: setting(30, 1, 600),
  gatewayRequestSeconds: setting(10, 1, 300),
  gatewayRetrySeconds: setting(30, 1, 3600),
  gatewayRestartMaxSeconds: setting(300, 1, 3600),
  telegramPollSeconds: setting(30, 1, 50),
} as const;

export const limitSettings = {
  contextBytes: setting(256 * kib, 16 * kib, 16 * mib),
  historyTurns: setting(20, 1, 200),
  modelTurns: setting(16, 1, 128),
  toolCalls: setting(16, 1, 256),
  toolBytes: setting(16 * kib, kib, 64 * kib),
  soulBytes: setting(8 * kib, 1, 64 * kib),
  profileBytes: setting(8 * kib, 1, 64 * kib),
  skillIndexBytes: setting(8 * kib, 0, 64 * kib),
  skillIndexEntries: setting(64, 1, 512),
  skillDescriptionBytes: setting(240, 16, 4 * kib),
  skillMentions: setting(4, 0, 32),
  attachmentsPerMessage: setting(4, 0, 10),
  imageBytes: setting(5 * mib, kib, 20 * mib),
  textFileBytes: setting(64 * kib, kib, mib),
  imagesPerRequest: setting(8, 0, 64),
  imageContextBytes: setting(6 * kib, kib, 64 * kib),
  replyTextBytes: setting(128 * kib, 4 * kib, 4 * mib),
  completionBytes: setting(mib, 16 * kib, 16 * mib),
  pageBytes: setting(mib, 64 * kib, 16 * mib),
  mcpTools: setting(128, 1, 1024),
  mcpDiscoveryBytes: setting(256 * kib, 16 * kib, 4 * mib),
  tasks: setting(64, 1, 1024),
  chatTaskCreatesPerRun: setting(5, 0, 64),
  chatTaskIntervalMinutes: setting(5, 1, 1440),
  workerLogBytes: setting(5 * mib, 64 * kib, 256 * mib),
  webChatBodyBytes: setting(256 * kib, 64 * kib, 16 * mib),
  webChatStreams: setting(32, 1, 256),
} as const;

export type TimeoutName = keyof typeof timeoutSettings;

export type LimitName = keyof typeof limitSettings;

const bounded = ({ minimum, maximum }: Setting) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

const read = (section: "timeouts" | "limits", name: string, value: Setting) =>
  Config.schema(bounded(value), [section, name]).pipe(
    Config.withDefault(value.fallback),
    Effect.orDie,
  );

export const TimeoutSettings = Schema.Struct(
  Record.map(timeoutSettings, (value) => Schema.optionalKey(bounded(value))),
);

export const LimitSettings = Schema.Struct(
  Record.map(limitSettings, (value) => Schema.optionalKey(bounded(value))),
);

export const timeoutSeconds = (name: TimeoutName): Effect.Effect<number> =>
  read("timeouts", name, timeoutSettings[name]);

export const timeout = (name: TimeoutName): Effect.Effect<Duration.Duration> =>
  Effect.map(timeoutSeconds(name), Duration.seconds);

export const limit = (name: LimitName): Effect.Effect<number> =>
  read("limits", name, limitSettings[name]);

export const resolvedTimeouts = Effect.all(
  Record.map(timeoutSettings, (_, name) => timeoutSeconds(name)),
);

export const resolvedLimits = Effect.all(Record.map(limitSettings, (_, name) => limit(name)));

export const timeoutAfter =
  (name: TimeoutName) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(timeout(name), (duration) => Effect.timeout(effect, duration));
