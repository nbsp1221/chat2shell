import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { PublishedPort, RuntimeInfo, SandboxDriver } from "../src/sandbox/sbx-driver.js";
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
  async expose(_name: string, sandboxPort: number): Promise<PublishedPort> { return { sandboxPort, hostPort: 32_000 }; }
  async remove(name: string): Promise<void> { this.removeCalls += 1; this.runtimes.delete(name); }
  async list(): Promise<readonly RuntimeInfo[]> { return [...this.runtimes.values()]; }
}

function config(base: string): AppConfig {
  return {
    host: "127.0.0.1", port: 0, maxBodyBytes: 1024, dataRoot: path.join(base, "data"),
    workspaceRoot: path.join(base, "data", "workspaces"), stateDir: path.join(base, "state"), databasePath: ":memory:",
    allowedHostRoots: [path.join(base, "allowed")], sbxBinary: "sbx", sandboxTemplate: "test:latest",
    sandboxPort: 18_787, idleTimeoutMs: 1_000,
    workspaceRetentionMs: 7_000, reaperIntervalMs: 100,
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

test("exposes a running sandbox port on an automatically assigned host port", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-expose-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const service = new SandboxService({ database, workspaces, driver: new FakeDriver(), config: appConfig });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await service.create("owner", {});
  assert(created.sandbox);
  assert.deepEqual(await service.expose("owner", created.sandbox.id, 3_000), {
    sandboxId: created.sandbox.id,
    sandboxPort: 3_000,
    hostPort: 32_000,
  });
  await assert.rejects(() => service.expose("owner", created.sandbox!.id, 0), /integer from 1 to 65535/);
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

test("every completed tool call renews the idle deadline without an absolute lifetime", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-activity-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  let now = 1_000;
  const service = new SandboxService({ database, workspaces, driver, config: appConfig, now: () => now });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await service.create("owner", {});
  assert(created.sandbox);
  const sandboxId = created.sandbox.id;

  for (let call = 0; call < 30; call += 1) {
    now += 500;
    await service.withReady("owner", sandboxId, async () => undefined);
  }
  assert.equal(service.get("owner", sandboxId).expiresAt, now + appConfig.idleTimeoutMs);

  now += 500;
  await assert.rejects(
    service.withReady("owner", sandboxId, async () => { throw new Error("tool failed"); }),
    /tool failed/,
  );
  const afterFailure = service.get("owner", sandboxId);
  assert.equal(afterFailure.lastActivityAt, now);
  assert.equal(afterFailure.expiresAt, now + appConfig.idleTimeoutMs);
});

test("idle removal retains its managed workspace for the configured period", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-expiry-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  let now = 1_000;
  const service = new SandboxService({ database, workspaces, driver, config: appConfig, now: () => now });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await service.create("owner", {});
  assert(created.sandbox);
  now += appConfig.idleTimeoutMs;

  const result = await service.reap();
  const workspace = workspaces.list("owner")[0];
  assert.deepEqual(result.destroyed, [created.sandbox.id]);
  assert.equal(workspace?.status, "retained");
  assert.equal(workspace?.retainedUntil, now + appConfig.workspaceRetentionMs);
});

test("idle cleanup rechecks activity after an in-flight call", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-reaper-race-"));
  fs.mkdirSync(path.join(base, "allowed"));
  const database = new StateDatabase(":memory:");
  const appConfig = config(base);
  const workspaces = new WorkspaceService({ database, dataRoot: appConfig.dataRoot, workspaceRoot: appConfig.workspaceRoot, allowedHostRoots: appConfig.allowedHostRoots });
  const driver = new FakeDriver();
  let now = 1_000;
  const service = new SandboxService({ database, workspaces, driver, config: appConfig, now: () => now });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });

  const created = await service.create("owner", {});
  assert(created.sandbox);
  let finishCall!: () => void;
  const inFlightCall = service.withReady("owner", created.sandbox.id, async () => {
    await new Promise<void>((resolve) => { finishCall = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));

  now += appConfig.idleTimeoutMs;
  const cleanup = service.reap();
  finishCall();
  await inFlightCall;

  assert.deepEqual((await cleanup).destroyed, []);
  assert.equal(service.get("owner", created.sandbox.id).status, "running");
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
