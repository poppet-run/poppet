# Gemini

[Engineering notes](../README.md)

`gemini` calls the Gemini Developer API's native `streamGenerateContent`
endpoint with a Google AI Studio API key. The package is
`@poppet/provider-gemini`. See [providers](../providers.md) for the shared
contract.

## Discovery

`service.ts` lists `GET /v1beta/models` with the key, following
`nextPageToken` until the last page. A repeated token or more than 20 pages
fails as an unsupported catalog. The whole listing shares the
`timeouts.modelCatalogSeconds` deadline. The cache key holds the base URL and a
hash of the key.

Model IDs drop the `models/` prefix. Discovery keeps `gemini-*` models that
support `generateContent`. It leaves out image, speech, live audio, embedding,
and computer-use variants, and Gemma models, which reject system instructions
and function declarations. `inputTokenLimit` and `outputTokenLimit` become the
context window and output limit. Every listed model accepts tools and images. A
model accepts temperature when its catalog entry has a default temperature. A
malformed entry is skipped when the catalog has usable entries.

## Requests

Inference loads the key from `POPPET_GEMINI_API_KEY` or `auth/gemini.json` and
sends it in `x-goog-api-key`, never in the URL. `protocol.ts` reads the
server-sent events itself, so no SDK sits between the adapter and the wire.

- Response headers must arrive within `timeouts.providerRequestSeconds`. The
  shared `modelStream` scope enforces the inference deadline and aborts the
  request on cancellation.
- Tools become `functionDeclarations` with `parametersJsonSchema`. Tool choice
  maps to `AUTO`, `ANY`, or `NONE`. Results for parallel calls go back together
  in one turn, with the call ID when Gemini supplied one.
- PNG, JPEG, and WebP attachments go inline. GIF fails before sending.
- A reasoning summary request asks thinking models to include thoughts. Thought
  text streams as reasoning and stays out of the answer.
- The `generate-content` continuation keeps the model's parts as received,
  including thought signatures, so a follow-up turn replays the signed
  function call. See [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).
  Fragments of one text part are joined until the part is signed.
- Only a `STOP` finish completes. `MAX_TOKENS`, safety stops, a missing
  finish, an undeclared tool, or parts after the finish fail.
- `API_KEY_INVALID` and `401` map to authentication, `403` to permission, and
  `429` to rate limiting, or to quota when a daily quota ran out. A `400` about
  the token count maps to the context limit, and `5xx`, `UNAVAILABLE`, and
  `INTERNAL` to temporary failures. Error messages from Google are not kept.
