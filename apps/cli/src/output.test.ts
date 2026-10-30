import { expect, test } from "bun:test";

import { fields, table, tree } from "#src/output";

test("tables align columns and shorten only the last column to fit the terminal", () => {
  const rows = [
    ["a", "first", "A short note"],
    ["long-id", "second", "A note that is much too long\nfor the window"],
  ];

  expect(table(["ID", "NAME", "NOTE"], rows, 30).split("\n")).toEqual([
    "ID       NAME    NOTE",
    "a        first   A short note",
    "long-id  second  A note that …",
  ]);
  expect(table(["ID", "NAME", "NOTE"], rows).split("\n").at(-1)).toBe(
    "long-id  second  A note that is much too long for the window",
  );
});

test("fields align labels and skip omitted entries", () => {
  expect(fields([["ID", "task"], null, ["Next run", "none"]])).toBe(
    "ID:        task\nNext run:  none",
  );
});

test("trees label nested settings in sentence case", () => {
  expect(tree({ mcpServers: [], chat: { logReasoning: false, outputTokens: 2048 } })).toBe(
    "MCP servers:  -\nChat:\n  Log reasoning:  no\n  Output tokens:  2048",
  );
});
