import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkspaceIdentity } from "../src/codexpro/client-pool.js";

test("replaces CodexPro's internal workspace identity with the public chat2shell identity", () => {
  const result = normalizeWorkspaceIdentity({
    content: [{ type: "text", text: "Workspace ws_internal selected; ws_internal is ready." }],
    structuredContent: {
      workspace_id: "ws_internal",
      selected_workspace_id: "ws_internal",
      root: "/workspace",
    },
  }, "ws_public");

  assert.deepEqual(result.structuredContent, {
    workspace_id: "ws_public",
    selected_workspace_id: "ws_public",
    root: "/workspace",
  });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "Workspace ws_public selected; ws_public is ready.");
});

test("leaves results without a CodexPro workspace identity untouched", () => {
  const result = {
    content: [{ type: "text" as const, text: "No workspace identity" }],
    structuredContent: { status: "ok" },
  };

  assert.equal(normalizeWorkspaceIdentity(result, "ws_public"), result);
});
