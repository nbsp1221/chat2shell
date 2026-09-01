import assert from "node:assert/strict";
import test from "node:test";
import { codexProToolManifest, scopedCodexProTool } from "../src/codexpro/tool-manifest.js";

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
