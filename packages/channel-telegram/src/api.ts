import { ChannelError, type Attachment } from "@poppet/gateway";
import { readBounded } from "@poppet/io";
import { Effect, Redacted, Schema } from "effect";

import type { TelegramSettings } from "#src/settings";

export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Only Telegram's resolved relative file path may become a token-bearing download URL. */
export const telegramDownload = (
  settings: TelegramSettings,
  http: HttpFetch,
  attachment: Attachment,
  maxBytes: number,
) =>
  Effect.gen(function* () {
    const file = yield* telegramApi(settings, http)(
      "getFile",
      { file_id: attachment.fileId },
      Schema.Struct({
        file_id: Schema.String,
        file_size: Schema.optionalKey(Schema.Natural),
        file_path: Schema.String.check(Schema.isMaxLength(512)),
      }),
    ).pipe(
      Effect.mapError((error) =>
        error.reason === "permission"
          ? new ChannelError({
              reason: "attachment",
              message: "Telegram can no longer supply this attachment. Send the file again.",
            })
          : error,
      ),
    );

    if (
      file.file_id !== attachment.fileId ||
      !/^[A-Za-z0-9_./-]+$/.test(file.file_path) ||
      file.file_path.split("/").some((part) => !part || part === "." || part === "..")
    )
      return yield* Effect.fail(
        new ChannelError({
          reason: "attachment",
          message: "Telegram returned an invalid attachment reference. Send the file again.",
        }),
      );

    if (file.file_size !== undefined && file.file_size > maxBytes)
      return yield* Effect.fail(
        new ChannelError({
          reason: "attachment",
          message: "Attachment exceeds its download limit.",
        }),
      );

    return yield* Effect.tryPromise({
      try: async (signal) => {
        const url = `https://api.telegram.org/file/bot${Redacted.value(settings.token)}/${file.file_path}`;

        const response = await http(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });

        if (!response.ok || response.redirected || (response.url && response.url !== url))
          throw new Error("Invalid download");

        if (!response.body) throw new Error("Missing file");

        return readBounded(
          response.body,
          maxBytes,
          () =>
            new ChannelError({
              reason: "attachment",
              message: "Attachment exceeds its download limit.",
            }),
        );
      },
      catch: (cause) =>
        cause instanceof ChannelError
          ? cause
          : new ChannelError({
              reason: "unavailable",
              message:
                "Cannot download this Telegram attachment. Try sending it again if the reference has expired.",
            }),
    });
  });

const Envelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error_code: Schema.Int,
    parameters: Schema.optionalKey(
      Schema.Struct({ retry_after: Schema.optionalKey(Schema.Natural) }),
    ),
  }),
]);

/** Keeps token-bearing URLs and remote diagnostics out of application errors. */
export const telegramApi =
  (settings: TelegramSettings, http: HttpFetch) =>
  <A>(
    method: string,
    body: Schema.JsonObject,
    result: Schema.ConstraintDecoder<A>,
    sending = false,
    timeout = 10000,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await http(
          `https://api.telegram.org/bot${Redacted.value(settings.token)}/${method}`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );

        if (!response.body) throw new Error("Missing Telegram response");

        const bytes = await readBounded(
          response.body,
          2 * 1024 * 1024,
          () => new Error("Oversized Telegram response"),
        );

        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(
          Buffer.from(bytes).toString("utf8"),
        );

        if (!decoded.ok) {
          const code = decoded.error_code;
          throw new ChannelError({
            reason:
              code === 429
                ? "unavailable"
                : code === 401 || code === 409
                  ? "configuration"
                  : code >= 400 && code < 500
                    ? "permission"
                    : sending
                      ? "uncertain"
                      : "unavailable",
            message:
              "Telegram request failed. Check the bot token, private chat access, and that no other poller or webhook is active.",
            retryAfterMs:
              (decoded.parameters?.retry_after ?? (code === 401 || code === 409 ? 30 : 1)) * 1000,
          });
        }

        if (!response.ok) throw new Error("Invalid Telegram status");

        return Schema.decodeUnknownSync(result)(decoded.result);
      },
      catch: (cause) =>
        cause instanceof ChannelError
          ? cause
          : new ChannelError({
              reason: sending ? "uncertain" : "unavailable",
              message: sending
                ? "Telegram may have accepted the reply. Inspect its delivery before reposting."
                : "Telegram is unavailable or returned an invalid response.",
            }),
    });
