import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Sandbox } from "../domain/types.js";
import type { SandboxService } from "../sandbox/service.js";

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly result?: CallToolResult;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export function normalizeWorkspaceIdentity(result: CallToolResult, workspaceId: string): CallToolResult {
  const structuredContent = result.structuredContent;
  if (!structuredContent) return result;

  const internalIds = [structuredContent.workspace_id, structuredContent.selected_workspace_id]
    .filter((value): value is string => typeof value === "string" && value !== workspaceId);
  if (internalIds.length === 0) return result;

  const publicText = (text: string): string => internalIds.reduce(
    (normalized, internalId) => normalized.replaceAll(internalId, workspaceId),
    text,
  );
  return {
    ...result,
    content: result.content.map((item) => item.type === "text" ? { ...item, text: publicText(item.text) } : item),
    structuredContent: {
      ...structuredContent,
      ...(typeof structuredContent.workspace_id === "string" ? { workspace_id: workspaceId } : {}),
      ...(typeof structuredContent.selected_workspace_id === "string" ? { selected_workspace_id: workspaceId } : {}),
    },
  };
}

function parseEventStream(text: string, expectedId: number): JsonRpcResponse {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const message = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
    if (message.id === expectedId) return message;
  }
  throw new Error("CodexPro returned an event stream without the expected response");
}

class CodexProSession {
  readonly #endpoint: string;
  readonly #token: string;
  #sessionId?: string;
  #nextId = 1;

  constructor(sandbox: Sandbox) {
    if (!sandbox.endpoint || !sandbox.authToken) throw new Error("Sandbox is missing its CodexPro connection");
    this.#endpoint = sandbox.endpoint;
    this.#token = sandbox.authToken;
  }

  matches(sandbox: Sandbox): boolean {
    return this.#endpoint === sandbox.endpoint && this.#token === sandbox.authToken;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.#sessionId) await this.#initialize();
    try {
      const response = await this.#request("tools/call", { name, arguments: args });
      if (response.error) throw new Error(`CodexPro ${response.error.code}: ${response.error.message}`);
      if (!response.result) throw new Error("CodexPro returned no tool result");
      return response.result;
    } catch (error) {
      if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
      this.#sessionId = undefined;
      await this.#initialize();
      const response = await this.#request("tools/call", { name, arguments: args });
      if (response.error) throw new Error(`CodexPro ${response.error.code}: ${response.error.message}`);
      if (!response.result) throw new Error("CodexPro returned no tool result");
      return response.result;
    }
  }

  async close(): Promise<void> {
    if (!this.#sessionId) return;
    await fetch(this.#endpoint, {
      method: "DELETE",
      headers: this.#headers(),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    this.#sessionId = undefined;
  }

  async #initialize(): Promise<void> {
    const response = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chat2shell", version: "0.2.0" },
    }, false);
    if (response.error) throw new Error(`CodexPro initialize failed: ${response.error.message}`);
    if (!this.#sessionId) throw new Error("CodexPro initialize response did not include a session id");
    await fetch(this.#endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async #request(method: string, params: Record<string, unknown>, includeSession = true): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: this.#headers(includeSession),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(610_000),
    });
    if (!response.ok) throw new Error(`CodexPro HTTP ${response.status}: ${await response.text()}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    const text = await response.text();
    return response.headers.get("content-type")?.includes("text/event-stream")
      ? parseEventStream(text, id)
      : JSON.parse(text) as JsonRpcResponse;
  }

  #headers(includeSession = true): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
    };
    if (includeSession && this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    return headers;
  }
}

export class CodexProClientPool {
  readonly #sandboxes: SandboxService;
  readonly #sessions = new Map<string, CodexProSession>();

  constructor(sandboxes: SandboxService) {
    this.#sandboxes = sandboxes;
    sandboxes.onDestroy((sandboxId) => this.close(sandboxId));
  }

  async call(ownerId: string, sandboxId: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.#sandboxes.withReady(ownerId, sandboxId, async (sandbox) => {
      let session = this.#sessions.get(sandbox.id);
      if (!session?.matches(sandbox)) {
        await session?.close();
        session = new CodexProSession(sandbox);
        this.#sessions.set(sandbox.id, session);
      }
      return normalizeWorkspaceIdentity(await session.callTool(toolName, args), sandbox.workspaceId);
    });
  }

  async close(sandboxId: string): Promise<void> {
    const session = this.#sessions.get(sandboxId);
    this.#sessions.delete(sandboxId);
    await session?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
    this.#sessions.clear();
  }
}
