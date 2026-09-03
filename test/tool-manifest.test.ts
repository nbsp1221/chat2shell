import assert from "node:assert/strict";
import test from "node:test";
import { codexProToolManifest, publicCodexProTools, scopedCodexProTool } from "../src/codexpro/tool-manifest.js";

test("every CodexPro tool schema is static and scoped by an explicit sandbox_id", () => {
  const tools = codexProToolManifest();
  assert(tools.length > 10);
  for (const rawTool of tools) {
    assert.equal(rawTool.inputSchema.properties?.workspace_id, undefined, rawTool.name);
    const tool = scopedCodexProTool(rawTool);
    assert.ok(tool.inputSchema.required?.includes("sandbox_id"), tool.name);
    assert.equal((tool.inputSchema.properties?.sandbox_id as { type?: string }).type, "string", tool.name);
  }
  assert.equal(tools.some((tool) => tool.name === "open_workspace"), false);
  assert.match(tools.find((tool) => tool.name === "bash")?.description ?? "", /unrestricted Bash/);
});

test("the public Bash contract uses explicit long-running sessions", () => {
  const tools = publicCodexProTools();
  const bash = tools.find((tool) => tool.name === "bash");
  const poll = tools.find((tool) => tool.name === "bash_poll");
  const stop = tools.find((tool) => tool.name === "bash_stop");
  assert.equal(tools.length, codexProToolManifest().length + 2);
  assert.equal(bash?.inputSchema.properties?.session_id, undefined);
  assert.equal((bash?.inputSchema.properties?.yield_time_ms as { maximum?: number }).maximum, 60_000);
  assert.equal((bash?.inputSchema.properties?.yield_time_ms as { default?: number }).default, 10_000);
  assert.equal((bash?.inputSchema.properties?.timeout_ms as { maximum?: number }).maximum, undefined);
  assert.equal((poll?.inputSchema.properties?.yield_time_ms as { maximum?: number }).maximum, 60_000);
  assert.equal((poll?.inputSchema.properties?.yield_time_ms as { default?: number }).default, 10_000);
  assert.deepEqual(poll?.outputSchema, bash?.outputSchema);
  assert.deepEqual(stop?.outputSchema, bash?.outputSchema);
  assert.deepEqual((bash?.outputSchema?.properties?.status as { enum?: string[] }).enum, ["running", "exited"]);
});
