import type { Server } from 'node:http';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { SingleUserAuthProvider } from '../auth/single-user-provider.js';
import { BashSessionService } from '../codexpro/bash-sessions.js';
import { CodexProClientPool } from '../codexpro/client-pool.js';
import { publicCodexProTools } from '../codexpro/tool-manifest.js';
import { type RuntimeConfig, loadRuntimeConfig } from '../config.js';
import { createGateway } from '../mcp/gateway.js';
import { SbxDriver } from '../sandbox/sbx-driver.js';
import { SandboxService } from '../sandbox/service.js';
import { StateDatabase } from '../state/database.js';
import { WorkspaceService } from '../workspaces/service.js';

async function assertRuntimeAvailable(config: RuntimeConfig): Promise<void> {
  if (!config.tunnelEnabled) {
    return;
  }
  await Promise.all([
    access(config.tunnelClient),
    access(config.tunnelKeyPath),
    access(config.tunnelIdPath),
  ]);
}

async function claimRuntime(config: RuntimeConfig): Promise<void> {
  await mkdir(config.stateDir, { mode: 0o700, recursive: true });
  await chmod(config.stateDir, 0o700);
  let existingPid: number | undefined;
  try {
    existingPid = Number((await readFile(config.runtimePidPath, 'utf8')).trim());
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }
  if (Number.isSafeInteger(existingPid) && existingPid && existingPid > 0) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`chat2shell is already running with PID ${existingPid}`);
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        throw error;
      }
    }
  }
  await rm(config.tunnelHealthUrlPath, { force: true });
  await writeFile(config.runtimePidPath, `${process.pid}\n`, { mode: 0o600 });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}

async function releaseRuntime(config: RuntimeConfig): Promise<void> {
  await Promise.all([
    rm(config.runtimePidPath, { force: true }),
    rm(config.tunnelHealthUrlPath, { force: true }),
  ]);
}

async function runRuntime(config: RuntimeConfig): Promise<void> {
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    database,
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
    allowedHostRoots: config.allowedHostRoots,
  });
  const driver = new SbxDriver({
    binary: config.sbxBinary,
    template: config.sandboxTemplate,
    sandboxPort: config.sandboxPort,
  });
  let server: Server | undefined;
  let tunnel: ChildProcess | undefined;
  let codexPro: CodexProClientPool | undefined;
  let reaper: NodeJS.Timeout | undefined;

  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });

  const onSignal = (): void => requestStop();

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await driver.assertReady();
    console.log('[chat2shell] reconciling previous sandbox state');
    const sandboxes = new SandboxService({ database, workspaces, driver, config });
    await sandboxes.reconcile();

    codexPro = new CodexProClientPool(sandboxes);
    const bashSessions = new BashSessionService(codexPro, (listener) =>
      sandboxes.onDestroy(listener),
    );
    const codexProTools = publicCodexProTools();
    server = createGateway(config, {
      authProvider: new SingleUserAuthProvider(),
      controlServer: { sandboxes, workspaces, codexPro, bashSessions, codexProTools },
    });
    await listen(server, config);
    console.log(`[chat2shell] MCP ready at http://${config.host}:${config.port}/mcp`);
    console.log(`[chat2shell] ${codexProTools.length} CodexPro tools are sandbox-scoped`);

    reaper = setInterval(() => {
      sandboxes.reap().catch((error) => console.error('[chat2shell] reaper failed', error));
    }, config.reaperIntervalMs);
    reaper.unref();

    if (!config.tunnelEnabled) {
      console.log('[chat2shell] tunnel disabled');
      await stopRequested;
      return;
    }

    const tunnelId = (await readFile(config.tunnelIdPath, 'utf8')).trim();
    if (!tunnelId) {
      throw new Error('Tunnel ID file is empty');
    }
    const tunnelProcess = startTunnel(config, tunnelId);
    tunnel = tunnelProcess;
    console.log('[chat2shell] tunnel client started');
    const tunnelExit = new Promise<{
      kind: 'tunnel';
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      tunnelProcess.once('exit', (code, signal) => resolve({ kind: 'tunnel', code, signal }));
      tunnelProcess.once('error', reject);
    });
    const outcome = await Promise.race([
      stopRequested.then(() => ({ kind: 'stop' as const })),
      tunnelExit,
    ]);
    if (outcome.kind === 'tunnel' && outcome.code !== 0) {
      throw new Error(
        `tunnel-client exited unexpectedly (${outcome.signal ? `signal ${outcome.signal}` : `code ${String(outcome.code)}`})`,
      );
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (reaper) {
      clearInterval(reaper);
    }
    await stopChild(tunnel);
    if (server) {
      await closeServer(server);
    }
    await codexPro?.closeAll();
    database.close();
  }
}

export async function serve(config: RuntimeConfig = loadRuntimeConfig()): Promise<void> {
  await assertRuntimeAvailable(config);
  await claimRuntime(config);
  try {
    await runRuntime(config);
  } finally {
    await releaseRuntime(config);
  }
}

async function listen(server: Server, config: RuntimeConfig): Promise<void> {
  server.listen(config.port, config.host);
  await once(server, 'listening');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function startTunnel(config: RuntimeConfig, tunnelId: string): ChildProcess {
  return spawn(
    config.tunnelClient,
    [
      'run',
      '--mcp.server-url',
      `http://${config.host}:${config.port}/mcp`,
      '--control-plane.api-key',
      `file:${config.tunnelKeyPath}`,
      '--control-plane.tunnel-id',
      tunnelId,
      '--health.listen-addr',
      '127.0.0.1:0',
      '--health.url-file',
      config.tunnelHealthUrlPath,
      '--log.file',
      `${config.stateDir}/tunnel-client.log`,
    ],
    { stdio: 'inherit' },
  );
}
