import assert from "node:assert/strict";
import test from "node:test";
import { loadCodexProToolManifest, scopedCodexProTool } from "../src/codexpro/tool-manifest.js";

test("every CodexPro tool schema is scoped by an explicit sandbox_id", async () => {
  const tools = await loadCodexProToolManifest("/tmp", "standard");
  assert(tools.length > 10);
  for (const tool of tools.map(scopedCodexProTool)) {
    assert.ok(tool.inputSchema.required?.includes("sandbox_id"), tool.name);
    assert.equal((tool.inputSchema.properties?.sandbox_id as { type?: string }).type, "string", tool.name);
  }
});
