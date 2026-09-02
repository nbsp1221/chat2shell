import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../config.js";
import type { AuthProvider } from "../auth/provider.js";
import { sessionlessDiscoverResponse } from "./compatibility.js";
import { createControlServer, type ControlServerDependencies } from "./control-server.js";

type ControlServerWithoutPrincipal = Omit<ControlServerDependencies, "principalId">;

export interface GatewayDependencies {
  readonly authProvider: AuthProvider;
  readonly controlServer: ControlServerWithoutPrincipal;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBodyBytes) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  dependencies: GatewayDependencies,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
  if (requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (requestUrl.pathname !== "/mcp") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });
    return;
  }

  const principal = await dependencies.authProvider.authenticate(request.headers);
  const body = await readBody(request, config.maxBodyBytes);
  const compatibilityResponse = sessionlessDiscoverResponse(request.headers, body);
  if (compatibilityResponse) {
    sendJson(response, 200, compatibilityResponse);
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createControlServer({ ...dependencies.controlServer, principalId: principal.id });
  await mcpServer.connect(transport);
  try {
    await transport.handleRequest(request, response, parsedBody);
  } finally {
    await transport.close();
    await mcpServer.close();
  }
}

export function createGateway(config: AppConfig, dependencies: GatewayDependencies): Server {
  return http.createServer((request, response) => {
    handleRequest(request, response, config, dependencies).catch((error: unknown) => {
      if (response.writableEnded || response.headersSent) return;
      const status = error instanceof Error && error.message === "payload_too_large" ? 413 : 500;
      const message = status === 413 ? "Payload too large" : "Internal chat2shell error";
      sendJson(response, status, { error: status === 413 ? "payload_too_large" : "internal_error", message });
      if (status === 500) console.error(error);
    });
  });
}
