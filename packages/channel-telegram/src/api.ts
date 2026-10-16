import { ChannelError } from "@poppet/gateway";
import { Effect, Redacted, Schema } from "effect";

import type { TelegramSettings } from "#src/settings";

export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

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

        const reader = response.body?.getReader();

        if (!reader) throw new Error("Missing Telegram response");
        const parts: Uint8Array[] = [];
        let bytes = 0;

        try {
          while (true) {
            // eslint-disable-next-line no-await-in-loop -- Response chunks arrive in order.
            const item = await reader.read();

            if (item.done) break;
            bytes += item.value.length;

            if (bytes > 2 * 1024 * 1024) throw new Error("Oversized Telegram response");
            parts.push(item.value);
          }
        } finally {
          await reader.cancel();
        }

        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(
          Buffer.concat(parts).toString("utf8"),
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
