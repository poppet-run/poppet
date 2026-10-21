import assert from "node:assert/strict";

import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { compileSchema } from "@poppet/mcp/catalog";
import { ScopedStdioTransport } from "@poppet/mcp/transport";
import { Schema } from "effect";

export const calculatorEnvironment = (directory: string) => ({
  HOME: directory,
  TMPDIR: directory,
  PATH: "/usr/bin:/bin",
  DO_NOT_TRACK: "1",
  CUA_DRIVER_PERMISSION_MODE: "bounded",
  CUA_DRIVER_CAPABILITY_MANIFEST_FILE: `${directory}/manifest.json`,
  CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
  CUA_DRIVER_POLICY_FILE: `${directory}/policy.rego`,
  CUA_DRIVER_MANAGED_POLICY_FILE: `${directory}/guard.yaml`,
});

export const openCalculatorDriver = async (
  command: string,
  args: ReadonlyArray<string>,
  directory: string,
  signal: AbortSignal,
  environment = calculatorEnvironment(directory),
  startupSignal = AbortSignal.timeout(8000),
) => {
  const client = new Client(
    { name: "poppet-calculator-probe", version: "0.0.0" },
    { capabilities: {} },
  );

  const transport = new ScopedStdioTransport({
    command,
    args: [...args],
    cwd: directory,
    env: environment,
    stderr: "pipe",
    maxBufferSize: 262144,
  });

  let stderrBytes = 0;
  let overflow = false;
  const calls: Array<{ tool: string; outcome: string }> = [];

  const close = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  };

  const stop = () => {
    void close().catch(() => {});
  };

  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;

    if (stderrBytes > 262144) {
      overflow = true;
      stop();
    }
  });
  signal.addEventListener("abort", stop, { once: true });

  try {
    await client.connect(transport, {
      signal: AbortSignal.any([signal, startupSignal]),
      timeout: 8000,
    });
    const pid = transport.pid;
    assert(pid !== null && !overflow, "Driver startup failed.");

    return {
      pid,
      client,
      calls,
      call: async (name: string, arguments_: Schema.JsonObject) => {
        assert(!signal.aborted && !overflow, "Driver stopped.");

        try {
          const result = await client.request(
            { method: "tools/call", params: { name, arguments: arguments_ } },
            { signal, timeout: 10000 },
          );

          assert(!overflow, "Driver stderr exceeds 256 KiB.");
          calls.push({ tool: name, outcome: result.isError ? "refused" : "completed" });

          return result;
        } catch (error) {
          const rejected = error instanceof Error && "code" in error && error.code === -32602;
          calls.push({ tool: name, outcome: rejected ? "rejected-before-dispatch" : "uncertain" });

          if (!rejected) {
            await close();
            overflow = true;
          }

          throw error;
        }
      },
      close: async () => {
        signal.removeEventListener("abort", stop);
        await close();
        assert(!alive(pid), "Driver child survived cleanup.");
      },
    };
  } catch {
    signal.removeEventListener("abort", stop);
    await close();
    throw new Error("Bounded driver startup failed.");
  }
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

export type CalculatorDriver = Awaited<ReturnType<typeof openCalculatorDriver>>;

export const calculatorResult = (result: CallToolResult) => {
  assert(
    result.content.every((part) => part.type === "text"),
    "Unexpected driver media.",
  );
  assert(Buffer.byteLength(JSON.stringify(result)) <= 262144, "Oversized driver result.");

  const data = Schema.decodeUnknownSync(Schema.JsonObject)(result.structuredContent);
  assert(!("capture_id" in data) && !("screenshot_file_path" in data), "Unexpected capture.");

  return data;
};

export const discoverCalculatorTools = async (
  driver: CalculatorDriver,
  allowed: ReadonlyArray<string>,
) => {
  const tools: Tool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;

  for (let page = 0; ; page++) {
    assert(page < 8, "Discovery exceeds 8 pages.");

    // eslint-disable-next-line no-await-in-loop
    const result = await driver.client.request(
      { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
      { timeout: 5000 },
    );

    bytes += Buffer.byteLength(JSON.stringify(result));
    assert(bytes <= 262144 && tools.length + result.tools.length <= 128, "Oversized discovery.");

    for (const tool of result.tools) {
      assert(!names.has(tool.name) && tool.name.length <= 256, "Invalid tool identity.");
      names.add(tool.name);
      assert(allowed.includes(tool.name), "Unexpected discovered tool.");
      compileSchema(Schema.decodeUnknownSync(Schema.JsonObject)(tool.inputSchema));

      if (tool.outputSchema)
        compileSchema(Schema.decodeUnknownSync(Schema.JsonObject)(tool.outputSchema));
      tools.push(tool);
    }

    cursor = result.nextCursor;

    if (cursor === undefined) break;
    assert(cursor.length <= 1024 && !cursors.has(cursor), "Invalid discovery cursor.");
    cursors.add(cursor);
  }

  for (const name of allowed) assert(names.has(name), "Missing trial tool.");

  return tools;
};
