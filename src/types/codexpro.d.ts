declare module "codexpro/dist/config.js" {
  export function loadConfig(argv?: readonly string[]): unknown;
}

declare module "codexpro/dist/server.js" {
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  export function createCodexProServer(config: unknown): McpServer;
}
