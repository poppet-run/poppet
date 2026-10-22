# Tool definitions

[Refactoring plans](index.md)

## Goal

Build tool parameter schemas and decode tool-call arguments in one way, and
share the byte-bounded text schema.

## Current state

Nine tool definitions repeat the same parameter conversion:

```ts
parameters: Schema.decodeUnknownSync(Schema.JsonObject)(
  Schema.toJsonSchemaDocument(X, { onExcessProperty: "error" }).schema,
),
```

These are `agent/src/{web-search,pages,memory-tools,task-tools,notes}.ts`,
`agent/src/search.ts` (twice), `tasks/src/monitor-tools.ts`, and
`browser/src/browser.ts`. `notes.ts` already has a local `definition` helper for
this.

Most of them then decode arguments with
`Schema.decodeUnknownEffect(Schema.fromJsonString(X), { onExcessProperty: "error" })`
and map failures to
`AgentError({ reason: "tool-arguments", message: "Invalid arguments for <namespace>.<name>." })`.
Browser maps failures to its own `BrowserError` and adds a 64 KiB argument cap.
Monitor tools use `decodeUnknownOption`.

A trimmed, nonempty string capped at N UTF-8 bytes is defined three times:
`agent/src/task-tools.ts` (`text`), `agent/src/web-search.ts` (inline, 512), and
`tasks/src/monitoring.ts`.

## Design

`browser` depends only on `@poppet/provider`, so the schema conversion lives
there, next to the `Tool` schema in `packages/provider/src/schema.ts`:

```ts
/** Strict JSON Schema parameters for a tool's arguments. */
export const toolParameters: (schema: Schema.Top) => Schema.JsonObject;

/** Decodes a tool call's JSON arguments strictly; callers map the error. */
export const decodeToolArguments: <S extends Schema.Top>(
  schema: S,
) => (json: string) => Effect.Effect<S["Type"], Schema.SchemaError>;
```

`@poppet/agent` adds the `AgentError` wrapper and the shared text schema, and
exports them for `tasks`:

```ts
export const toolArguments: <S extends Schema.Top>(
  tool: Tool,
  schema: S,
) => (json: string) => Effect.Effect<S["Type"], AgentError>;
// message: `Invalid arguments for ${tool.namespace}.${tool.name}.`

export const BoundedText: (bytes: number) => Schema.String-like;
```

Check the exact Effect 4 type names (`Schema.Top`, `Schema.SchemaError`) when
implementing. Use whatever the current call sites already accept.

## Steps

1. Add `toolParameters` and `decodeToolArguments` to `@poppet/provider` and
   export them.
2. Add `toolArguments` and `BoundedText` to `@poppet/agent` (for example in a
   new `src/tool-schema.ts`) and export them.
3. Convert the agent tools one file at a time: `web-search`, `pages`, `search`,
   `memory-tools`, `task-tools`, `notes` (drop its local `definition`).
4. Convert `tasks/src/monitor-tools.ts` (parameters only; keep its
   option-based decode) and replace `text` in `tasks/src/monitoring.ts` with
   `BoundedText`.
5. Convert `browser/src/browser.ts` to `toolParameters`, keeping its
   `properties: {}` / `required: []` defaults and its 64 KiB check.

## Verification

Tool JSON schemas must be byte-identical, since providers see them. Before step
3, add a snapshot-style test that serialises every exported `Tool` and compare
it before and after. Existing argument-error tests in
`agent/src/*.test.ts`, `tasks/src/chat-tools.test.ts`, and `browser.test.ts`
check the messages.
