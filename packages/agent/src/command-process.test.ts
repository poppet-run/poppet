import { test } from "bun:test";

test("pinned POSIX command runtime preserves invocation and bounds cancellation, descendants and output", async () => {
  await import("#src/test/command-check");
}, 10000);
