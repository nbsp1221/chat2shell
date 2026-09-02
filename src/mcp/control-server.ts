import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CodexProClientPool } from "../codexpro/client-pool.js";
import { scopedCodexProTool } from "../codexpro/tool-manifest.js";
import type { SandboxService } from "../sandbox/service.js";
import type { WorkspaceService } from "../workspaces/service.js";

const sandboxCreateTool: Tool = {
  name: "sandbox_create",
  title: "Create or Reuse Sandbox",
  description: "Create an isolated Docker Sandbox, reuse the active sandbox for a workspace, or request host approval for a new host path.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: { type: "string", description: "Approved persistent workspace id. Omit with workspace_path to create a managed workspace." },
      workspace_path: { type: "string", description: "Host path to request. It is never mounted until approved locally." },
      workspace_mode: { type: "string", enum: ["managed", "clone", "direct"], description: "Defaults to managed without a path and clone with a host path." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
};

const sandboxListTool: Tool = {
  name: "sandbox_list",
  title: "List Sandboxes",
  description: "List running and failed sandboxes owned by the current chat2shell principal. Running IDs can be reused from other conversations; failed sandboxes must be destroyed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const sandboxGetTool: Tool = {
  name: "sandbox_get",
  title: "Get Sandbox",
  description: "Get the current state, workspace, and expiration times for one sandbox.",
  inputSchema: {
    type: "object",
    properties: { sandbox_id: { type: "string" } },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const sandboxDestroyTool: Tool = {
  name: "sandbox_destroy",
  title: "Destroy Sandbox",
  description: "Permanently remove one sandbox microVM. Managed workspace files are retained for 30 days; registered host workspaces are never deleted.",
  inputSchema: {
    type: "object",
    properties: { sandbox_id: { type: "string" } },
    required: ["sandbox_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
};

const workspaceListTool: Tool = {
  name: "workspace_list",
  title: "List Workspaces",
  description: "List managed and locally approved workspaces available to the current principal.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const managementTools = [sandboxCreateTool, sandboxListTool, sandboxGetTool, sandboxDestroyTool, workspaceListTool] as const;

function objectArgs(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object");
  return value as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface ControlServerDependencies {
  readonly principalId: string;
  readonly sandboxes: Pick<SandboxService, "create" | "list" | "get" | "destroy">;
  readonly workspaces: Pick<WorkspaceService, "list">;
  readonly codexPro: Pick<CodexProClientPool, "call">;
  readonly codexProTools: readonly Tool[];
}

export function createControlServer(dependencies: ControlServerDependencies): Server {
  const server = new Server(
    { name: "chat2shell", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions: "Create or select an isolated sandbox first. Every CodexPro tool requires an explicit sandbox_id. Bash is unrestricted inside the sandbox but never has host shell or host Docker access.",
    },
  );
  const codexTools = dependencies.codexProTools.map(scopedCodexProTool);
  const codexToolNames = new Set(codexTools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...managementTools, ...codexTools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = objectArgs(request.params.arguments);
      switch (request.params.name) {
        case "sandbox_create": {
          const modeValue = optionalString(args, "workspace_mode");
          const mode = modeValue as "managed" | "clone" | "direct" | undefined;
          if (mode && mode !== "managed" && mode !== "clone" && mode !== "direct") throw new Error("workspace_mode must be managed, clone, or direct");
          return jsonResult(await dependencies.sandboxes.create(dependencies.principalId, {
            workspaceId: optionalString(args, "workspace_id"),
            workspacePath: optionalString(args, "workspace_path"),
            workspaceMode: mode,
          }));
        }
        case "sandbox_list":
          return jsonResult({ sandboxes: dependencies.sandboxes.list(dependencies.principalId) });
        case "sandbox_get":
          return jsonResult(dependencies.sandboxes.get(dependencies.principalId, optionalString(args, "sandbox_id") ?? ""));
        case "sandbox_destroy":
          return jsonResult(await dependencies.sandboxes.destroy(dependencies.principalId, optionalString(args, "sandbox_id") ?? ""));
        case "workspace_list":
          return jsonResult({ workspaces: dependencies.workspaces.list(dependencies.principalId) });
        default: {
          if (!codexToolNames.has(request.params.name)) throw new Error(`Unknown tool: ${request.params.name}`);
          const sandboxId = optionalString(args, "sandbox_id");
          if (!sandboxId) throw new Error("sandbox_id is required");
          if ("workspace_id" in args) throw new Error("CodexPro workspace_id is internal; select the target with sandbox_id");
          const { sandbox_id: _sandboxId, ...upstreamArgs } = args;
          return await dependencies.codexPro.call(dependencies.principalId, sandboxId, request.params.name, upstreamArgs);
        }
      }
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
