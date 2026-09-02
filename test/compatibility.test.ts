import assert from "node:assert/strict";
import test from "node:test";
import { sessionlessDiscoverResponse } from "../src/mcp/compatibility.js";

test("returns method-not-found for a sessionless server/discover probe", () => {
  const response = sessionlessDiscoverResponse(
    {},
    Buffer.from('{"jsonrpc":"2.0","id":"probe","method":"server/discover","params":{}}'),
  );

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: "probe",
    error: { code: -32601, message: "Method not found" },
  });
});

test("does not intercept established MCP sessions", () => {
  const response = sessionlessDiscoverResponse(
    { "mcp-session-id": "session-1" },
    Buffer.from('{"jsonrpc":"2.0","id":1,"method":"server/discover"}'),
  );

  assert.equal(response, undefined);
});
