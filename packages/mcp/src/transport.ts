import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Share teardown when SDK handshake failure and owner cleanup close the same child concurrently. */
export class ScopedStdioTransport extends StdioClientTransport {
  private closing: Promise<void> | null = null;

  override close(): Promise<void> {
    this.closing ??= this.closeProcess();

    return this.closing;
  }

  private async closeProcess() {
    const pid = this.pid;

    await super.close();

    if (pid === null) return;

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }

      // Wait for the SDK's final SIGKILL to reach process exit and reap its handle.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("MCP child did not exit after shutdown.");
  }
}
