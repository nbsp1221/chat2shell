import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import standardTools from "./standard-tools.json" with { type: "json" };

const bashContinueTool: Tool = {
  name: "bash_continue",
  title: "Continue Bash Session",
  description: "Read new combined stdout/stderr and the current status of a Bash session. Empty output means the process is still running without new output.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string", description: "Sandbox id used to start the Bash session." },
      session_id: { type: "string", description: "Session id returned by bash." },
    },
    required: ["sandbox_id", "session_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const bashStopTool: Tool = {
  name: "bash_stop",
  title: "Stop Bash Session",
  description: "Stop a running Bash session with SIGTERM, followed by SIGKILL after 1.5 seconds if it has not exited.",
  inputSchema: {
    type: "object",
    properties: {
      sandbox_id: { type: "string", description: "Sandbox id used to start the Bash session." },
      session_id: { type: "string", description: "Session id returned by bash." },
    },
    required: ["sandbox_id", "session_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
};

export function codexProToolManifest(): readonly Tool[] {
  return standardTools as unknown as readonly Tool[];
}

export function scopedCodexProTool(tool: Tool): Tool {
  const properties = tool.inputSchema.properties ?? {};
  if ("sandbox_id" in properties) throw new Error(`CodexPro tool conflicts with the chat2shell routing field: ${tool.name}`);
  const scoped: Tool = {
    ...tool,
    description: `${tool.description ?? tool.name} Runs only inside the selected chat2shell sandbox.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        sandbox_id: {
          type: "string",
          description: "Sandbox id from sandbox_create or sandbox_list.",
        },
        ...properties,
      },
      required: [...new Set(["sandbox_id", ...(tool.inputSchema.required ?? [])])],
      additionalProperties: false,
    },
  };
  if (tool.name !== "bash") return scoped;
  const { session_id: _sessionId, timeout_ms: _timeoutMs, ...bashProperties } = scoped.inputSchema.properties as Record<string, unknown>;
  return {
    ...scoped,
    description: "Run unrestricted Bash inside the selected sandbox. Commands that outlive yield_time_ms continue running and return a session_id for bash_continue or bash_stop. There is no execution timeout unless timeout_ms is explicitly provided. The command cannot access the host shell or host Docker daemon.",
    inputSchema: {
      ...scoped.inputSchema,
      properties: {
        ...bashProperties,
        yield_time_ms: { type: "integer", minimum: 0, maximum: 60_000, description: "How long to wait for completion before returning a running session. Default: 10000." },
        timeout_ms: { type: "integer", minimum: 1_000, description: "Optional execution time limit. Without this argument the process has no time limit." },
      },
    },
  };
}

export function publicCodexProTools(): readonly Tool[] {
  return [...codexProToolManifest().map(scopedCodexProTool), bashContinueTool, bashStopTool];
}
