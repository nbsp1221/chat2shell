import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { RuntimeInfo, SandboxDriver } from "../src/sandbox/sbx-driver.js";
import { SandboxService } from "../src/sandbox/service.js";
import { StateDatabase } from "../src/state/database.js";
import { WorkspaceService } from "../src/workspaces/service.js";

class FakeDriver implements SandboxDriver {
  readonly runtimes = new Map<string, RuntimeInfo>();
  createCalls = 0;
  startCalls = 0;
  removeCalls = 0;
  healthy = true;
  async assertReady(): Promise<void> {}
  async create(name: string): Promise<{ endpoint: string; runtimeRoot: string }> {
    this.createCalls += 1;
    this.runtimes.set(name, { name, status: "running" });
    return { endpoint: "http://127.0.0.1:1234/mcp", runtimeRoot: "/workspace" };
  }
  async startCodexPro(): Promise<void> { this.startCalls += 1; }
  async waitUntilHealthy(): Promise<void> {}
  async isHealthy(): Promise<boolean> { return this.healthy; }
  async remove(name: string): Promise<void> { this.removeCalls += 1; this.runtimes.delete(name); }
  async list(): Promise<readonly RuntimeInfo[]> { return [...this.runtimes.values()]; }
}

function config(base: string): AppConfig {
  return {
    host: "127.0.0.1", port: 0, maxBodyBytes: 1024, dataRoot: path.join(base, "data"),
    workspaceRoot: path.join(base, "data", "workspaces"), stateDir: path.join(base, "state"), databasePath: ":memory:",
    allowedHostRoots: [path.join(base, "allowed")], sbxBinary: "sbx", sandboxTemplate: "test:latest",
    sandboxCpus: 1, sandboxMemory: "1g", sandboxPort: 18_787, idleTimeoutMs: 1_000,
    maxLifetimeMs: 10_000, workspaceRetentionMs: 7_000, reaperIntervalMs: 100,
  };
}

test("explicit sandbox ids are reusable and one active sandbox is kept per workspace", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-sandbox-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  const service = new SandboxService({ database, workspaces, driver, config: appConfig });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const first = await service.create("owner", {});
  assert.equal(first.status, "created");
  assert(first.sandbox);
  const second = await service.create("owner", { workspaceId: first.sandbox.workspace.id });
  assert.equal(second.status, "reused");
  assert.equal(second.sandbox?.id, first.sandbox.id);
  assert.equal(driver.createCalls, 1);
  await assert.rejects(() => service.create("owner", { workspaceId: first.sandbox!.workspace.id, workspaceMode: "clone" }), /does not match/);

  const destroyed = await service.destroy("owner", first.sandbox.id);
  assert.equal(destroyed.status, "destroyed");
  assert.equal(driver.removeCalls, 1);
  assert.equal(workspaces.list("owner")[0]?.status, "retained");
});

test("host workspace requests stop at approval_required", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-approval-"));
  const repository = path.join(base, "allowed", "repo");
  fs.mkdirSync(repository, { recursive: true });
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  const service = new SandboxService({ database, workspaces, driver, config: appConfig });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const result = await service.create("owner", { workspacePath: repository, workspaceMode: "direct" });
  assert.equal(result.status, "approval_required");
  assert.match(result.approval?.id ?? "", /^approval_/);
  assert.equal(driver.createCalls, 0);
});

test("an unavailable runtime becomes an explicit failed sandbox without automatic restart", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-failed-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  const service = new SandboxService({ database, workspaces, driver, config: appConfig });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await service.create("owner", {});
  assert(created.sandbox);
  driver.healthy = false;

  await assert.rejects(() => service.readyForTool("owner", created.sandbox!.id), /destroy this sandbox and create a new one/);
  assert.equal(driver.startCalls, 1, "health failure must not start another CodexPro process");
  assert.equal(service.list("owner")[0]?.status, "failed");
});

test("a controller restart invalidates runtimes that the new controller does not own", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-reconcile-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  const firstController = new SandboxService({ database, workspaces, driver, config: appConfig });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await firstController.create("owner", {});
  assert(created.sandbox);
  const restartedController = new SandboxService({ database, workspaces, driver, config: appConfig });
  await restartedController.reconcile();

  assert.equal(driver.removeCalls, 1);
  assert.equal(restartedController.list("owner")[0]?.status, "failed");
  assert.match(restartedController.list("owner")[0]?.error ?? "", /chat2shell restarted/);
});
