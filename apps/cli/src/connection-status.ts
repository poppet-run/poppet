import { invalidRequest, ProviderError, type ProviderId } from "@poppet/provider";
import { Effect, Schema } from "effect";

const ConnectionMetadata = Schema.Struct({
  connected: Schema.Boolean,
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  planUsage: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  source: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** Shares validated snapshots between model resolution and status queries in one runtime. */
export const createConnectionStatus = () => {
  const observed = new Map<ProviderId, Schema.JsonObject>();

  const observe = (id: ProviderId, status: Schema.JsonObject) =>
    Schema.decodeUnknownEffect(ConnectionMetadata)(status).pipe(
      Effect.map((metadata): Schema.JsonObject => {
        const snapshot = {
          provider: id,
          account: metadata.email ?? null,
          connected: metadata.connected,
          planUsage: metadata.planUsage ?? null,
          expiresAt: metadata.expiresAt ?? null,
          source: metadata.source ?? null,
          observedAt: Date.now(),
          cached: false,
          action: !metadata.connected
            ? `Run auth login ${id}.`
            : metadata.planUsage === false
              ? `Run auth login ${id} --consent.`
              : null,
        };

        observed.set(id, snapshot);

        return snapshot;
      }),
      Effect.mapError(() => invalidRequest(id, "The provider returned invalid connection status.")),
    );

  const fallback = (id: ProviderId, error: ProviderError): Effect.Effect<Schema.JsonObject> => {
    const cached = observed.get(id);

    if (
      error instanceof ProviderError &&
      error.code === "credential_store_busy" &&
      cached !== undefined
    )
      return Effect.succeed({ ...cached, cached: true });

    return Effect.succeed({
      provider: id,
      connected: null,
      account: null,
      planUsage: null,
      action:
        error instanceof ProviderError && error.code === "credential_store_busy"
          ? "Authentication is busy. Check again after the active run finishes."
          : `Run auth status ${id} to inspect the connection.`,
    } satisfies Schema.JsonObject);
  };

  return { observe, fallback };
};
