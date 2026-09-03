import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import type { SandboxCreateResult, SandboxSummary } from '../../src/domain/types.js';
import type { PublishedPort, RuntimeInfo, SandboxDriver } from '../../src/sandbox/sbx-driver.js';
import { SandboxService } from '../../src/sandbox/service.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

class FakeDriver implements SandboxDriver {
  readonly runtimes = new Map<string, RuntimeInfo>();
  createCalls = 0;
  healthy = true;
  removeCalls = 0;
  startCalls = 0;

  assertReady(): Promise<void> {
    return Promise.resolve();
  }

  create(name: string): Promise<{ endpoint: string; runtimeRoot: string }> {
    this.createCalls += 1;
    this.runtimes.set(name, { name, status: 'running' });
    return Promise.resolve({ endpoint: 'http://127.0.0.1:1234/mcp', runtimeRoot: '/workspace' });
  }

  expose(_name: string, sandboxPort: number): Promise<PublishedPort> {
    return Promise.resolve({ hostPort: 32_000, sandboxPort });
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.healthy);
  }

  list(): Promise<readonly RuntimeInfo[]> {
    return Promise.resolve([...this.runtimes.values()]);
  }

  remove(name: string): Promise<void> {
    this.removeCalls += 1;
    this.runtimes.delete(name);
    return Promise.resolve();
  }

  startCodexPro(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  waitUntilHealthy(): Promise<void> {
    return Promise.resolve();
  }
}

function config(base: string): AppConfig {
  return {
    allowedHostRoots: [path.join(base, 'allowed')],
    dataRoot: path.join(base, 'data'),
    databasePath: ':memory:',
    host: '127.0.0.1',
    idleTimeoutMs: 1_000,
    maxBodyBytes: 1_024,
    port: 0,
    reaperIntervalMs: 100,
    sandboxPort: 18_787,
    sandboxTemplate: 'test:latest',
    sbxBinary: 'sbx',
    stateDir: path.join(base, 'state'),
    workspaceRetentionMs: 7_000,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  };
}

function fixture(
  prefix: string,
  now?: () => number,
): {
  appConfig: AppConfig;
  base: string;
  database: StateDatabase;
  driver: FakeDriver;
  service: SandboxService;
  workspaces: WorkspaceService;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(base, 'allowed'));
  const database = new StateDatabase(':memory:');
  const appConfig = config(base);
  const workspaces = new WorkspaceService({
    allowedHostRoots: appConfig.allowedHostRoots,
    dataRoot: appConfig.dataRoot,
    database,
    workspaceRoot: appConfig.workspaceRoot,
  });
  const driver = new FakeDriver();
  const service = new SandboxService({ config: appConfig, database, driver, now, workspaces });

  onTestFinished(() => {
    database.close();
    fs.rmSync(base, { force: true, recursive: true });
  });

  return { appConfig, base, database, driver, service, workspaces };
}

function sandboxFrom(result: SandboxCreateResult): SandboxSummary {
  if (!result.sandbox) {
    throw new Error(`Expected sandbox result, received ${result.status}`);
  }
  return result.sandbox;
}

test('explicit sandbox ids are reusable and one active sandbox is kept per workspace', async () => {
  const { driver, service, workspaces } = fixture('chat2shell-sandbox-');

  const firstResult = await service.create('owner', {});
  expect(firstResult.status).toBe('created');
  const first = sandboxFrom(firstResult);

  const secondResult = await service.create('owner', { workspaceId: first.workspace.id });
  expect(secondResult.status).toBe('reused');
  expect(sandboxFrom(secondResult).id).toBe(first.id);
  expect(driver.createCalls).toBe(1);
  await expect(
    service.create('owner', { workspaceId: first.workspace.id, workspaceMode: 'clone' }),
  ).rejects.toThrow(/does not match/);

  const destroyed = await service.destroy('owner', first.id);
  expect(destroyed.status).toBe('destroyed');
  expect(driver.removeCalls).toBe(1);
  expect(workspaces.list('owner')[0]?.status).toBe('retained');
});

test('host workspace requests stop at approval_required', async () => {
  const { base, driver, service } = fixture('chat2shell-approval-');
  const repository = path.join(base, 'allowed', 'repo');
  fs.mkdirSync(repository, { recursive: true });

  const result = await service.create('owner', {
    workspaceMode: 'direct',
    workspacePath: repository,
  });
  expect(result.status).toBe('approval_required');
  expect(result.approval?.id ?? '').toMatch(/^approval_/);
  expect(driver.createCalls).toBe(0);
});

test('exposes a running sandbox port on an automatically assigned host port', async () => {
  const { service } = fixture('chat2shell-expose-');
  const created = sandboxFrom(await service.create('owner', {}));

  await expect(service.expose('owner', created.id, 3_000)).resolves.toEqual({
    hostPort: 32_000,
    sandboxId: created.id,
    sandboxPort: 3_000,
  });
  await expect(service.expose('owner', created.id, 0)).rejects.toThrow(/integer from 1 to 65535/);
});

test('an unavailable runtime becomes an explicit failed sandbox without automatic restart', async () => {
  const { driver, service } = fixture('chat2shell-failed-');
  const created = sandboxFrom(await service.create('owner', {}));
  driver.healthy = false;

  await expect(service.readyForTool('owner', created.id)).rejects.toThrow(
    /destroy this sandbox and create a new one/,
  );
  expect(driver.startCalls).toBe(1);
  expect(service.list('owner')[0]?.status).toBe('failed');
});

test('every completed tool call renews the idle deadline without an absolute lifetime', async () => {
  let now = 1_000;
  const { appConfig, service } = fixture('chat2shell-activity-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));

  for (let call = 0; call < 30; call += 1) {
    now += 500;
    await service.withReady('owner', created.id, () => Promise.resolve());
  }
  expect(service.get('owner', created.id).expiresAt).toBe(now + appConfig.idleTimeoutMs);

  now += 500;
  await expect(
    service.withReady('owner', created.id, () => Promise.reject(new Error('tool failed'))),
  ).rejects.toThrow(/tool failed/);
  const afterFailure = service.get('owner', created.id);
  expect(afterFailure.lastActivityAt).toBe(now);
  expect(afterFailure.expiresAt).toBe(now + appConfig.idleTimeoutMs);
});

test('idle removal retains its managed workspace for the configured period', async () => {
  let now = 1_000;
  const { appConfig, service, workspaces } = fixture('chat2shell-expiry-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));
  now += appConfig.idleTimeoutMs;

  const result = await service.reap();
  const workspace = workspaces.list('owner')[0];
  expect(result.destroyed).toEqual([created.id]);
  expect(workspace?.status).toBe('retained');
  expect(workspace?.retainedUntil).toBe(now + appConfig.workspaceRetentionMs);
});

test('idle cleanup rechecks activity after an in-flight call', async () => {
  let now = 1_000;
  const { appConfig, service } = fixture('chat2shell-reaper-race-', () => now);
  const created = sandboxFrom(await service.create('owner', {}));
  let finishCall: (() => void) | undefined;
  const inFlightCall = service.withReady('owner', created.id, async () => {
    await new Promise<void>((resolve) => {
      finishCall = resolve;
    });
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  now += appConfig.idleTimeoutMs;
  const cleanup = service.reap();
  if (!finishCall) {
    throw new Error('Expected the in-flight call to start');
  }
  finishCall();
  await inFlightCall;

  expect((await cleanup).destroyed).toEqual([]);
  expect(service.get('owner', created.id).status).toBe('running');
});

test('a controller restart invalidates runtimes that the new controller does not own', async () => {
  const { appConfig, database, driver, service, workspaces } = fixture('chat2shell-reconcile-');
  const created = sandboxFrom(await service.create('owner', {}));
  expect(created.status).toBe('running');

  const restartedController = new SandboxService({
    config: appConfig,
    database,
    driver,
    workspaces,
  });
  await restartedController.reconcile();

  expect(driver.removeCalls).toBe(1);
  expect(restartedController.list('owner')[0]?.status).toBe('failed');
  expect(restartedController.list('owner')[0]?.error ?? '').toMatch(/chat2shell restarted/);
});
