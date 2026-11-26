# ChatGPT

[Engineering notes](../README.md)

`openai-chatgpt` signs in with OAuth and runs ChatGPT subscription inference over
streamed Responses requests. It needs no API key or client secret. The package is
`@poppet/provider-openai`. The [user guide](https://poppet.run/docs/providers/openai-chatgpt/)
covers sign-in. See [providers](../providers.md) for the shared contract.

| Path                  | Owns                                                       |
| --------------------- | ---------------------------------------------------------- |
| `src/registration.ts` | Live composition and connection operations                 |
| `src/connection.ts`   | Credential schemas, scopes, and redacted secrets           |
| `src/auth/`           | Login, refresh, status, and `CredentialStoreLive`          |
| `src/oauth/`          | Discovery, token exchange, and ID token validation         |
| `src/sign-in/`        | The authorization request and callback checks              |
| `src/model/`          | The model catalog, the Responses client, and error mapping |
| `src/test/fixtures/`  | Local OAuth and model servers shared by the tests          |

## Sign-in

`@poppet/sign-in` owns the browser step, shared with [MCP OAuth](../mcp.md#oauth):

- `callback.ts` runs an ephemeral listener on `127.0.0.1` and closes it on
  success, failure, timeout, or interruption. Shutdown drains the current
  response so the browser gets the confirmation page. The callback consumes one
  attempt and checks `state` before it reads an error or the code.
- `authorize.ts` opens the browser, or prints the link over SSH (`SSH_CONNECTION`
  or `SSH_TTY`), on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, or with
  `--no-browser`. A pasted callback address goes through the same checks as a
  browser callback and must use this attempt's state and port. An address that
  does not match is ignored so the user can paste again. Sign-in times out after
  five minutes. `--callback-port` pins the port for SSH forwarding, and a port in
  use fails before the link prints.

## OAuth

`OAuthClient` discovers endpoints from the fixed OpenAI issuer, checks their
origin, exchanges codes, and verifies RS256 ID tokens against JWKS. jose handles
JWT validation. Discovery is cached for an hour after a success, and a failure is
retried on the next request. An ID token with several audiences or an authorized
party must name Poppet's registered client ID. OAuth follows the public-client
protocol directly. See
[OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

The first sign-in registers Poppet with its own host ID and an issued client ID.
The client ID is saved before the code exchange, so a failed exchange can be
replaced without registering again. Later sign-ins reuse the registration and
host ID, including after logout. Poppet stores one account. A new sign-in must
verify as that account before its tokens replace the old ones. Login requests
plan-usage consent when the saved credentials lack it, and status reports
`planUsage: false` until then.

## Credentials

`auth/connection.json` is a `0600` file in a `0700` directory, written by atomic
replacement. Tokens are redacted in application values and never printed.

`CredentialStoreLive` holds the [owner lock](../storage.md#owner-lock) while any
of its builds in the process is open. All builds share one lock and one permit
per data directory, so concurrent requests take turns reading or refreshing, an
expiring token is renewed once, and other processes stay out until the last
build closes. An Effect semaphore serializes refresh and credential changes
inside a command.

A near-expiry access token is refreshed, and the rotated credentials are saved
together. If identity verification is unavailable right after a renewal, the
renewal is kept, and the next request verifies it before using the new access
token. A promoted renewal whose access token has already expired is refreshed
again.

Logout revokes the session with a 20-second deadline, including response
cleanup, and clears tokens and verification. It keeps the account, the
registration, and the host ID. `--forget` removes `connection.json`. The command
reports when revocation could not be confirmed.

## Models and inference

`ChatGPTModel` lists the account's visible models and calls the OpenAI SDK with
the OAuth bearer token. A successful catalog lookup is reused for up to a minute
(`timeouts.modelCatalogCacheSeconds`, where 0 turns the cache off)
in the same process. Each lookup still checks authentication, and credential
changes, expiry, or a model missing from the cache fetch again. `provider models`
always fetches. Failures are not cached and nothing is written to disk. Timing
logs show hits and misses.

A model accepts images only when its catalog entry lists `image` in
`input_modalities`. Without that field it is text-only.

Inference streams Responses requests with `store: false`. The adapter keeps
`response.output_item.done` items by output index, because the final event can
omit the output array's contents, and those items win over terminal snapshots
when it rebuilds history. Continuation keeps the validated output items,
including encrypted reasoning. Usage limits, ineligible accounts, temporary
failures, quota codes, and 403 permission responses map to separate
`ProviderError` reasons. See
[OpenAI inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Verification streams two requests. The second carries the complete tool and
reasoning history, and success is recorded only after `response.completed` and a
matching local tool result. Verification can record subscription metadata.
