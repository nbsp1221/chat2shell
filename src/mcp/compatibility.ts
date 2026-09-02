import type { IncomingHttpHeaders } from "node:http";

interface JsonRpcRequest {
  readonly id?: unknown;
  readonly method?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: unknown;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

export function sessionlessDiscoverResponse(
  headers: IncomingHttpHeaders,
  body: Buffer,
): JsonRpcErrorResponse | undefined {
  if (typeof headers["mcp-session-id"] === "string") {
    return undefined;
  }

  try {
    const request = JSON.parse(body.toString("utf8")) as JsonRpcRequest;
    if (request.method !== "server/discover") {
      return undefined;
    }

    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32601, message: "Method not found" },
    };
  } catch {
    return undefined;
  }
}
