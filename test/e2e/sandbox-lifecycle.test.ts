import type http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { SingleUserAuthProvider } from '../../src/auth/single-user-provider.js';
import { BashSessionService } from '../../src/codexpro/bash-sessions.js';
import { CodexProClientPool } from '../../src/codexpro/client-pool.js';
import { publicCodexProTools } from '../../src/codexpro/tool-manifest.js';
import { createGateway } from '../../src/mcp/gateway.js';
import { SbxDriver } from '../../src/sandbox/sbx-driver.js';
import { SandboxService } from '../../src/sandbox/service.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

function requireSbx(): void {
  const result = spawnSync('sbx', ['--help'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`E2E requires the Docker Sandboxes sbx executable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`E2E could not execute sbx: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return address.port;
}

async function rpc(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5).trim() : text) as Record<string, unknown>;
}

async function callTool(
  url: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await rpc(url, id, 'tools/call', { arguments: args, name });
  return response.result as Record<string, unknown>;
}

test('routes full shell and private Docker only into a real microVM', async () => {
  requireSbx();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-e2e-'));
  const allowedRoot = path.join(base, 'host');
  fs.mkdirSync(allowedRoot);
  const appConfig: AppConfig = {
    allowedHostRoots: [allowedRoot],
    dataRoot: path.join(base, 'data'),
    databasePath: path.join(base, 'data', 'state', 'test.sqlite'),
    host: '127.0.0.1',
    idleTimeoutMs: 24 * 60 * 60_000,
    maxBodyBytes: 20 * 1024 * 1024,
    maxActiveSandboxes: 1,
    port: 0,
    reaperIntervalMs: 60_000,
    sandboxPort: 18_787,
    sandboxTemplate: 'chat2shell-codexpro:0.30.0',
    sbxBinary: 'sbx',
    stateDir: path.join(base, 'data', 'state'),
    workspaceRetentionMs: 30 * 24 * 60 * 60_000,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  };
  const database = new StateDatabase(appConfig.databasePath);
  const workspaces = new WorkspaceService({
    allowedHostRoots: appConfig.allowedHostRoots,
    dataRoot: appConfig.dataRoot,
    database,
    workspaceRoot: appConfig.workspaceRoot,
  });
  const driver = new SbxDriver({
    binary: 'sbx',
    sandboxPort: appConfig.sandboxPort,
    template: appConfig.sandboxTemplate,
  });
  const sandboxes = new SandboxService({ config: appConfig, database, driver, workspaces });
  const clients = new CodexProClientPool(sandboxes);
  const bashSessions = new BashSessionService(clients, (listener) => sandboxes.onDestroy(listener));
  const tools = publicCodexProTools();
  const gateway = createGateway(appConfig, {
    authProvider: new SingleUserAuthProvider(),
    controlServer: { bashSessions, codexPro: clients, codexProTools: tools, sandboxes, workspaces },
  });
  let sandboxId: string | undefined;
  const hostEscapeMarker = path.join(os.tmpdir(), `chat2shell-host-escape-${randomUUID()}`);

  try {
    await driver.assertReady();
    const url = `http://127.0.0.1:${await listen(gateway)}/mcp`;
    await rpc(url, 1, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
      protocolVersion: '2025-06-18',
    });

    const listedTools = await rpc(url, 2, 'tools/list');
    const toolList = (
      listedTools.result as { tools: Array<{ inputSchema: { required?: string[] }; name: string }> }
    ).tools;
    expect(toolList.find((tool) => tool.name === 'bash')?.inputSchema.required).toContain(
      'sandbox_id',
    );

    const createResult = await callTool(url, 3, 'sandbox_create', { memory: '4g' });
    const created = createResult.structuredContent as {
      sandbox: { id: string; memory: string | null; workspace: { id: string; root: string } };
      status: string;
    };
    expect(created.status).toBe('created');
    expect(created.sandbox.memory).toBe('4g');
    sandboxId = created.sandbox.id;

    const overLimit = await callTool(url, 100, 'sandbox_create', {});
    expect(overLimit.isError).toBe(true);
    expect((overLimit.content as Array<{ text: string }>)[0]?.text).toMatch(
      /Active sandbox limit reached/,
    );

    const write = await callTool(url, 4, 'write', {
      content: 'isolated\n',
      path: 'proof.txt',
      sandbox_id: sandboxId,
    });
    expect(write.isError).not.toBe(true);
    expect((write.structuredContent as { workspace_id: string }).workspace_id).toBe(
      created.sandbox.workspace.id,
    );
    expect(fs.readFileSync(path.join(created.sandbox.workspace.root, 'proof.txt'), 'utf8')).toBe(
      'isolated\n',
    );

    const escape = await callTool(url, 5, 'bash', {
      command: `touch ${hostEscapeMarker}`,
      sandbox_id: sandboxId,
    });
    expect(escape.isError).not.toBe(true);
    expect(fs.existsSync(hostEscapeMarker), 'sandbox /tmp must not be the host /tmp').toBe(false);

    const docker = await callTool(url, 6, 'bash', {
      command: "docker info --format '{{.ServerVersion}}'",
      sandbox_id: sandboxId,
    });
    expect(docker.isError, JSON.stringify(docker)).not.toBe(true);

    const longCommand = await callTool(url, 7, 'bash', {
      command: 'printf start; sleep 2; printf alive',
      sandbox_id: sandboxId,
      yield_time_ms: 100,
    });
    expect(longCommand.isError, JSON.stringify(longCommand)).not.toBe(true);
    const started = longCommand.structuredContent as {
      output: string;
      session_id: string;
      status: string;
    };
    expect(started.status).toBe('running');
    expect(started.output).toMatch(/start/);

    const polled = await callTool(url, 8, 'bash_poll', {
      sandbox_id: sandboxId,
      session_id: started.session_id,
      yield_time_ms: 3_000,
    });
    expect((polled.structuredContent as { status: string }).status).toBe('exited');
    expect((polled.structuredContent as { output: string }).output).toMatch(/alive/);

    const timed = await callTool(url, 9, 'bash', {
      command: 'sleep 30',
      sandbox_id: sandboxId,
      timeout_ms: 1_000,
      yield_time_ms: 2_000,
    });
    expect((timed.structuredContent as { status: string }).status).toBe('exited');
    expect((timed.structuredContent as { exit_code: number }).exit_code).toBe(124);

    const afterLongCommand = await callTool(url, 10, 'bash', {
      command: 'printf still-alive',
      sandbox_id: sandboxId,
    });
    expect(afterLongCommand.isError, JSON.stringify(afterLongCommand)).not.toBe(true);

    const preview = await callTool(url, 11, 'bash', {
      command:
        'nohup node -e \'require("http").createServer((_request, response) => response.end("sandbox-preview")).listen(3000, "0.0.0.0")\' >/tmp/chat2shell-preview.log 2>&1 </dev/null &',
      sandbox_id: sandboxId,
    });
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);

    const exposed = await callTool(url, 12, 'sandbox_expose', {
      port: 3_000,
      sandbox_id: sandboxId,
    });
    expect(exposed.isError, JSON.stringify(exposed)).not.toBe(true);
    const exposure = exposed.structuredContent as {
      hostPort: number;
      sandboxId: string;
      sandboxPort: number;
    };
    expect(exposure.sandboxId).toBe(sandboxId);
    expect(exposure.sandboxPort).toBe(3_000);
    expect(await (await fetch(`http://127.0.0.1:${exposure.hostPort}`)).text()).toBe(
      'sandbox-preview',
    );

    const repeated = await callTool(url, 13, 'sandbox_expose', {
      port: 3_000,
      sandbox_id: sandboxId,
    });
    expect(repeated.structuredContent).toEqual(exposure);

    const listed = await callTool(url, 14, 'sandbox_list', {});
    expect(
      (listed.structuredContent as { sandboxes: Array<{ id: string }> }).sandboxes[0]?.id,
    ).toBe(sandboxId);

    const destroyed = await callTool(url, 15, 'sandbox_destroy', { sandbox_id: sandboxId });
    expect((destroyed.structuredContent as { status: string }).status).toBe('destroyed');
    sandboxId = undefined;
    expect(workspaces.list('local-owner')[0]?.status).toBe('retained');

    const hostRepository = path.join(allowedRoot, 'repository');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', process.cwd(), hostRepository]);
    const cloneWorkspace = workspaces.registerHost('local-owner', hostRepository, 'clone');
    const cloneCreateResult = await callTool(url, 16, 'sandbox_create', {
      workspace_id: cloneWorkspace.id,
    });
    const cloneCreated = cloneCreateResult.structuredContent as {
      sandbox: { id: string };
      status: string;
    };
    expect(cloneCreated.status).toBe('created');
    sandboxId = cloneCreated.sandbox.id;

    const cloneWrite = await callTool(url, 17, 'write', {
      content: 'private clone\n',
      path: 'clone-proof.txt',
      sandbox_id: sandboxId,
    });
    expect(cloneWrite.isError).not.toBe(true);
    expect(
      fs.existsSync(path.join(hostRepository, 'clone-proof.txt')),
      'clone mode must not modify the host checkout',
    ).toBe(false);

    await callTool(url, 18, 'sandbox_destroy', { sandbox_id: sandboxId });
    sandboxId = undefined;
  } finally {
    if (sandboxId) {
      await sandboxes.destroy('local-owner', sandboxId).catch(() => undefined);
    }
    await new Promise<void>((resolve) => {
      gateway.close(() => resolve());
    });
    await clients.closeAll();
    database.close();
    if (fs.existsSync(hostEscapeMarker)) {
      fs.rmSync(hostEscapeMarker, { force: true });
    }
    fs.rmSync(base, { force: true, recursive: true });
  }
});
