import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig as loadCodexProConfig } from "codexpro/dist/config.js";
import { createCodexProServer } from "codexpro/dist/server.js";

export async function loadCodexProToolManifest(root: string, toolMode: "minimal" | "standard" | "full"): Promise<readonly Tool[]> {
  const config = loadCodexProConfig([
    "--root", root,
    "--allow-root", root,
    "--host", "127.0.0.1",
    "--bash", "full",
    "--write", "workspace",
    "--tool-mode", toolMode,
  ]);
  const codexPro = createCodexProServer(config);
  const client = new Client({ name: "chat2shell-manifest", version: "0.2.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await codexPro.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await codexPro.close();
  }
}

export function scopedCodexProTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties ?? {};
  if ("sandbox_id" in properties) throw new Error(`CodexPro tool conflicts with the chat2shell routing field: ${tool.name}`);
  return {
    ...tool,
    description: `${tool.description ?? tool.name} Runs only inside the selected chat2shell sandbox.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        sandbox_id: {
          type: "string",
          description: "Stable chat2shell sandbox id from sandbox_create or sandbox_list.",
        },
        ...properties,
      },
      required: [...new Set(["sandbox_id", ...(tool.inputSchema.required ?? [])])],
      additionalProperties: false,
    },
  };
}
