import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SingleUserAuthProvider } from "../src/auth/single-user-provider.js";
import { CodexProClientPool } from "../src/codexpro/client-pool.js";
import { codexProToolManifest } from "../src/codexpro/tool-manifest.js";
import type { AppConfig } from "../src/config.js";
import { createGateway } from "../src/mcp/gateway.js";
import { SbxDriver } from "../src/sandbox/sbx-driver.js";
import { SandboxService } from "../src/sandbox/service.js";
import { StateDatabase } from "../src/state/database.js";
import { WorkspaceService } from "../src/workspaces/service.js";

const enabled = process.env.CHAT2SHELL_RUN_SBX_INTEGRATION === "1";

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function rpc(url: string, id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : text) as Record<string, unknown>;
}

async function callTool(url: string, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await rpc(url, id, "tools/call", { name, arguments: args });
  return response.result as Record<string, unknown>;
}

test("the public MCP boundary routes full shell and private Docker only into a real microVM", { skip: !enabled }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-integration-"));
  const allowedRoot = path.join(base, "host");
  fs.mkdirSync(allowedRoot);
  const appConfig: AppConfig = {
    host: "127.0.0.1", port: 0, maxBodyBytes: 20 * 1024 * 1024,
    dataRoot: path.join(base, "data"), workspaceRoot: path.join(base, "data", "workspaces"),
    stateDir: path.join(base, "data", "state"), databasePath: path.join(base, "data", "state", "test.sqlite"),
    allowedHostRoots: [allowedRoot], sbxBinary: "sbx", sandboxTemplate: "chat2shell-codexpro:0.30.0",
    sandboxCpus: 1, sandboxMemory: "2g", sandboxPort: 18_787, idleTimeoutMs: 30 * 60_000,
    maxLifetimeMs: 4 * 60 * 60_000, workspaceRetentionMs: 7 * 24 * 60 * 60_000,
    reaperIntervalMs: 60_000,
  };
  const database = new StateDatabase(appConfig.databasePath);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new SbxDriver({ binary: "sbx", template: appConfig.sandboxTemplate, cpus: 1, memory: "2g", sandboxPort: appConfig.sandboxPort });
  const sandboxes = new SandboxService({ database, workspaces, driver, config: appConfig });
  const clients = new CodexProClientPool(sandboxes);
  const tools = codexProToolManifest();
  const gateway = createGateway(appConfig, {
    authProvider: new SingleUserAuthProvider(),
    controlServer: { sandboxes, workspaces, codexPro: clients, codexProTools: tools },
  });
  let sandboxId: string | undefined;
  const hostEscapeMarker = path.join(os.tmpdir(), `chat2shell-host-escape-${randomUUID()}`);

  try {
    await driver.assertReady();
    const url = `http://127.0.0.1:${await listen(gateway)}/mcp`;
    await rpc(url, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "1" } });
    const listedTools = await rpc(url, 2, "tools/list");
    const toolList = (listedTools.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
    assert(toolList.find((tool) => tool.name === "bash")?.inputSchema.required?.includes("sandbox_id"));

    const createResult = await callTool(url, 3, "sandbox_create", {});
    const created = createResult.structuredContent as { status: string; sandbox: { id: string; workspace: { root: string } } };
    assert.equal(created.status, "created");
    sandboxId = created.sandbox.id;
    const runtimeName = `c2s-${sandboxId.slice(4, 25)}`;
    const policy = spawnSync("sbx", ["policy", "check", "network", "--sandbox", runtimeName, "openrouter.ai"], { encoding: "utf8" });
    assert.equal(policy.status, 1);
    assert.match(policy.stdout, /Denied/i, "chat2shell sandboxes must not use the inherited opencodex credential domain");

    const write = await callTool(url, 4, "write", { sandbox_id: sandboxId, path: "proof.txt", content: "isolated\n" });
    assert.notEqual(write.isError, true);
    assert.equal(fs.readFileSync(path.join(created.sandbox.workspace.root, "proof.txt"), "utf8"), "isolated\n");

    const escape = await callTool(url, 5, "bash", { sandbox_id: sandboxId, command: `touch ${hostEscapeMarker}` });
    assert.notEqual(escape.isError, true);
    assert.equal(fs.existsSync(hostEscapeMarker), false, "sandbox /tmp must not be the host /tmp");

    const docker = await callTool(url, 6, "bash", { sandbox_id: sandboxId, command: "docker info --format '{{.ServerVersion}}'" });
    assert.notEqual(docker.isError, true, JSON.stringify(docker));

    const longCommand = await callTool(url, 7, "bash", { sandbox_id: sandboxId, command: "sleep 35 && printf alive", timeout_ms: 60_000 });
    assert.notEqual(longCommand.isError, true, JSON.stringify(longCommand));
    const afterLongCommand = await callTool(url, 8, "bash", { sandbox_id: sandboxId, command: "printf still-alive" });
    assert.notEqual(afterLongCommand.isError, true, JSON.stringify(afterLongCommand));

    const listed = await callTool(url, 9, "sandbox_list", {});
    assert.equal((listed.structuredContent as { sandboxes: Array<{ id: string }> }).sandboxes[0]?.id, sandboxId);
    const destroyed = await callTool(url, 10, "sandbox_destroy", { sandbox_id: sandboxId });
    assert.equal((destroyed.structuredContent as { status: string }).status, "destroyed");
    sandboxId = undefined;
    assert.equal(workspaces.list("local-owner")[0]?.status, "retained");

    const hostRepository = path.join(allowedRoot, "repository");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", process.cwd(), hostRepository]);
    const cloneWorkspace = workspaces.registerHost("local-owner", hostRepository, "clone");
    const cloneCreateResult = await callTool(url, 11, "sandbox_create", { workspace_id: cloneWorkspace.id });
    const cloneCreated = cloneCreateResult.structuredContent as { status: string; sandbox: { id: string } };
    assert.equal(cloneCreated.status, "created");
    sandboxId = cloneCreated.sandbox.id;
    const cloneWrite = await callTool(url, 12, "write", { sandbox_id: sandboxId, path: "clone-proof.txt", content: "private clone\n" });
    assert.notEqual(cloneWrite.isError, true);
    assert.equal(fs.existsSync(path.join(hostRepository, "clone-proof.txt")), false, "clone mode must not modify the host checkout");
    await callTool(url, 13, "sandbox_destroy", { sandbox_id: sandboxId });
    sandboxId = undefined;
  } finally {
    if (sandboxId) await sandboxes.destroy("local-owner", sandboxId).catch(() => undefined);
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await clients.closeAll();
    database.close();
    if (fs.existsSync(hostEscapeMarker)) fs.rmSync(hostEscapeMarker, { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});
