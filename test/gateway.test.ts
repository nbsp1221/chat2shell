import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { SingleUserAuthProvider } from "../src/auth/single-user-provider.js";
import { createGateway } from "../src/mcp/gateway.js";

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

test("intercepts compatibility probes without calling upstream", async (context) => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1;
    response.end();
  });
  const upstreamPort = await listen(upstream);
  context.after(() => upstream.close());

  const gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamUrl: new URL(`http://127.0.0.1:${upstreamPort}/mcp`),
      maxBodyBytes: 1024,
    },
    { authProvider: new SingleUserAuthProvider() },
  );
  const gatewayPort = await listen(gateway);
  context.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json() as { error: { code: number } }).error.code, -32601);
  assert.equal(upstreamCalls, 0);
});

test("proxies MCP responses and session headers", async (context) => {
  const upstream = http.createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.writeHead(202, {
      "content-type": "application/json",
      "mcp-session-id": "upstream-session",
    });
    response.end(Buffer.concat(body).toString("utf8"));
  });
  const upstreamPort = await listen(upstream);
  context.after(() => upstream.close());

  const gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      upstreamUrl: new URL(`http://127.0.0.1:${upstreamPort}/mcp`),
      maxBodyBytes: 1024,
    },
    { authProvider: new SingleUserAuthProvider() },
  );
  const gatewayPort = await listen(gateway);
  context.after(() => gateway.close());

  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("mcp-session-id"), "upstream-session");
  assert.equal(await response.text(), requestBody);
});
