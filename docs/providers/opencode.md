# OpenCode

[Engineering notes](../README.md)

`@poppet/provider-opencode` registers two providers on one adapter: `opencode`
for pay-as-you-go workspace credit and `opencode-go` for the Go subscription. The
user guides cover [OpenCode Go](https://poppet.run/docs/providers/opencode-go/)
setup. See [providers](../providers.md) for the shared contract.

| Provider      | Catalog                                             | Key variable                 | Key file                |
| ------------- | --------------------------------------------------- | ---------------------------- | ----------------------- |
| `opencode`    | `https://opencode.ai/inference/openai/v1/models`    | `POPPET_OPENCODE_API_KEY`    | `auth/opencode.json`    |
| `opencode-go` | `https://opencode.ai/inference/go/openai/v1/models` | `POPPET_OPENCODE_GO_API_KEY` | `auth/opencode-go.json` |

## Discovery

`service.ts` fetches the catalog. With a key, it authenticates the request so
OpenCode returns only the models enabled for that workspace, and caches the
result per provider and credential. Without a key, it reads the public catalog. A
service account key needs the Models › Read permission for authenticated
discovery. A dropped connection while downloading the catalog is a temporary
failure.

Descriptions take the display name, context window, output limit, tool and
temperature support, and image input from the catalog. Discovery leaves out
decision, embedding, image, realtime, and video models, and free-tier models that
OpenCode limits to its own app.

## Requests

A model whose recommended API is Responses goes to `/responses` through the
Responses adapter. Every other chat model goes to `/chat/completions`, including
Anthropic Messages and Gemini models that OpenCode Console translates on the
server. Both send the Poppet user agent and a stable `x-opencode-session` header
from `protocol.ts`. Inference loads the key only when it starts.

Both providers save `reasoning_content` as continuation on Chat Completions.
Responses continuation keeps validated output items, as for ChatGPT. See
[OpenCode Console models](https://opencode.ai/docs/console/models/) and
[OpenCode Go](https://opencode.ai/docs/console/go/).
