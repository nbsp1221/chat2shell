import { SingleUserAuthProvider } from '../auth/single-user-provider.js';
import { CodexProClientPool } from '../codexpro/client-pool.js';
import { codexProToolManifest } from '../codexpro/tool-manifest.js';
import { loadAppConfig } from '../config.js';
import { SbxDriver } from '../sandbox/sbx-driver.js';
import { SandboxService } from '../sandbox/service.js';
import { StateDatabase } from '../state/database.js';
import { WorkspaceService } from '../workspaces/service.js';
import { createGateway } from './gateway.js';

const config = loadAppConfig();
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
await driver.assertReady();
const sandboxes = new SandboxService({ database, workspaces, driver, config });
await sandboxes.reconcile();
const codexPro = new CodexProClientPool(sandboxes);
const codexProTools = codexProToolManifest();
const server = createGateway(config, {
  authProvider: new SingleUserAuthProvider(),
  controlServer: { sandboxes, workspaces, codexPro, codexProTools },
});

server.listen(config.port, config.host, () => {
  console.log(`[chat2shell] listening on http://${config.host}:${config.port}/mcp`);
  console.log(`[chat2shell] ${codexProTools.length} CodexPro tools are sandbox-scoped`);
});

const reaper = setInterval(() => {
  sandboxes.reap().catch((error) => console.error('[chat2shell] reaper failed', error));
}, config.reaperIntervalMs);
reaper.unref();

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(reaper);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await codexPro.closeAll();
  database.close();
}

function requestShutdown(): void {
  void shutdown().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('[chat2shell] shutdown failed', error);
      process.exit(1);
    },
  );
}

process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);
