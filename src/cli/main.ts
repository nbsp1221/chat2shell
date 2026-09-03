import { loadAppConfig } from '../config.js';
import { StateDatabase } from '../state/database.js';
import { WorkspaceService } from '../workspaces/service.js';

const config = loadAppConfig();
const database = new StateDatabase(config.databasePath);
const workspaces = new WorkspaceService({
  database,
  workspaceRoot: config.workspaceRoot,
  dataRoot: config.dataRoot,
  allowedHostRoots: config.allowedHostRoots,
});
const [group, action, value, ...rest] = process.argv.slice(2);
const ownerId = 'local-owner';

function modeFrom(args: readonly string[]): 'clone' | 'direct' {
  const index = args.indexOf('--mode');
  const mode = index >= 0 ? args[index + 1] : 'clone';
  if (mode !== 'clone' && mode !== 'direct') {
    throw new Error('--mode must be clone or direct');
  }
  return mode;
}

try {
  if (group === 'workspace' && action === 'list') {
    console.log(JSON.stringify(workspaces.list(ownerId), null, 2));
  } else if (group === 'workspace' && action === 'add' && value) {
    console.log(JSON.stringify(workspaces.registerHost(ownerId, value, modeFrom(rest)), null, 2));
  } else if (group === 'approval' && action === 'list') {
    console.log(JSON.stringify(database.listApprovals(), null, 2));
  } else if (group === 'approval' && action === 'approve' && value) {
    console.log(JSON.stringify(workspaces.approve(value), null, 2));
  } else if (group === 'approval' && action === 'reject' && value) {
    console.log(JSON.stringify(workspaces.reject(value), null, 2));
  } else {
    console.error(
      'Usage:\n  chat2shell workspace list\n  chat2shell workspace add PATH [--mode clone|direct]\n  chat2shell approval list\n  chat2shell approval approve ID\n  chat2shell approval reject ID',
    );
    process.exitCode = 2;
  }
} finally {
  database.close();
}
