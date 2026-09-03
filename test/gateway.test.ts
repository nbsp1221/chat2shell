import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { SingleUserAuthProvider } from "../src/auth/single-user-provider.js";
import { createGateway } from "../src/mcp/gateway.js";

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

function config(): AppConfig {
  return {
    host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, dataRoot: "/tmp/chat2shell", workspaceRoot: "/tmp/chat2shell/workspaces",
    stateDir: "/tmp/chat2shell/state", databasePath: ":memory:", allowedHostRoots: ["/tmp"], sbxBinary: "sbx",
    sandboxTemplate: "test:latest", sandboxPort: 18_787,
    idleTimeoutMs: 1_000, workspaceRetentionMs: 10_000, reaperIntervalMs: 1_000,
  };
}

async function rpc(url: string, id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : text) as Record<string, unknown>;
}

test("serves management tools itself instead of proxying to a host CodexPro", async (context) => {
  let listCalls = 0;
  let exposedPort: number | undefined;
  const gateway = createGateway(config(), {
    authProvider: new SingleUserAuthProvider(),
    controlServer: {
      sandboxes: {
        async create() { throw new Error("not used"); },
        list() { listCalls += 1; return []; },
        get() { throw new Error("not used"); },
        async expose(_ownerId, sandboxId, port) {
          exposedPort = port;
          return { sandboxId, sandboxPort: port, hostPort: 32_000 };
        },
        async destroy() { throw new Error("not used"); },
      },
      workspaces: { list() { return []; } },
      codexPro: { async call() { throw new Error("not used"); } },
      bashSessions: {
        async start() { throw new Error("not used"); },
        async poll() { throw new Error("not used"); },
        async stop() { throw new Error("not used"); },
      },
      codexProTools: [],
    },
  });
  const port = await listen(gateway);
  context.after(() => gateway.close());
  const url = `http://127.0.0.1:${port}/mcp`;
  await rpc(url, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const listed = await rpc(url, 2, "tools/list");
  const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["sandbox_create", "sandbox_list", "sandbox_get", "sandbox_expose", "sandbox_destroy", "workspace_list"]);
  const called = await rpc(url, 3, "tools/call", { name: "sandbox_list", arguments: {} });
  assert.equal((called.result as { structuredContent: { sandboxes: unknown[] } }).structuredContent.sandboxes.length, 0);
  assert.equal(listCalls, 1);
  const exposed = await rpc(url, 4, "tools/call", { name: "sandbox_expose", arguments: { sandbox_id: "sbx_test", port: 3_000 } });
  assert.deepEqual((exposed.result as { structuredContent: unknown }).structuredContent, {
    sandboxId: "sbx_test",
    sandboxPort: 3_000,
    hostPort: 32_000,
  });
  assert.equal(exposedPort, 3_000);
});
