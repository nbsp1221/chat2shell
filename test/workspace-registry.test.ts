import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceRegistry } from "../src/workspaces/registry.js";

test("uses stable workspace aliases instead of transient process state", () => {
  const registry = new WorkspaceRegistry();
  registry.register("main", "/home/retn0/../retn0");

  assert.deepEqual(registry.resolve("main"), { alias: "main", root: "/home/retn0" });
  assert.throws(() => registry.resolve("missing"), /Unknown workspace alias/);
});
