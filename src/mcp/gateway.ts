import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuthProvider } from "../auth/provider.js";
import type { GatewayConfig } from "../config.js";
import { sessionlessDiscoverResponse } from "./compatibility.js";

export interface GatewayDependencies {
  readonly authProvider: AuthProvider;
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

function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  upstream: URL,
): void {
  const requestUrl = new URL(request.url ?? "/mcp", "http://localhost");
  const headers = { ...request.headers, host: upstream.host };
  delete headers["content-length"];

  const upstreamRequest = http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      path: `${upstream.pathname}${requestUrl.search}`,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("error", (error) => {
    if (response.writableEnded) return;
    sendJson(response, 502, { error: "upstream_unavailable", message: error.message });
  });
  request.on("aborted", () => upstreamRequest.destroy());
  if (body.length > 0) upstreamRequest.write(body);
  upstreamRequest.end();
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);

  if (requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (requestUrl.pathname !== "/mcp") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  await dependencies.authProvider.authenticate(request.headers);

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  request.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
    if (receivedBytes > config.maxBodyBytes) {
      response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
      response.end("Payload too large");
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });

  request.on("end", () => {
    if (response.writableEnded) return;
    const body = Buffer.concat(chunks);

    if (request.method === "POST") {
      const compatibilityResponse = sessionlessDiscoverResponse(request.headers, body);
      if (compatibilityResponse) {
        sendJson(response, 200, compatibilityResponse);
        return;
      }
    }

    proxyRequest(request, response, body, config.upstreamUrl);
  });
}

export function createGateway(config: GatewayConfig, dependencies: GatewayDependencies): Server {
  return http.createServer((request, response) => {
    handleRequest(request, response, config, dependencies).catch((error: unknown) => {
      if (response.writableEnded) return;
      const message = error instanceof Error ? error.message : "Unknown gateway error";
      sendJson(response, 500, { error: "gateway_error", message });
    });
  });
}
