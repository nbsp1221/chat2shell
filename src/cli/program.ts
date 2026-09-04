import { type CAC, cac } from 'cac';
import packageJson from '../../package.json' with { type: 'json' };
import { loadAppConfig, loadRuntimeConfig } from '../config.js';
import { serve } from '../runtime/serve.js';
import { StateDatabase } from '../state/database.js';
import { WorkspaceService } from '../workspaces/service.js';
import { setup } from './setup.js';
import { status } from './status.js';

const ownerId = 'local-owner';

function withWorkspaceServices<T>(
  operation: (services: { database: StateDatabase; workspaces: WorkspaceService }) => T,
): T {
  const config = loadAppConfig();
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    database,
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
    allowedHostRoots: config.allowedHostRoots,
  });
  try {
    return operation({ database, workspaces });
  } finally {
    database.close();
  }
}

export function createCli(): CAC {
  const cli = cac('chat2shell');
  cli.version(packageJson.version);
  cli.help();

  cli
    .command('setup', 'Check prerequisites and create the CodexPro sandbox template')
    .action(() => setup(loadRuntimeConfig()));

  cli
    .command('serve', 'Run the MCP gateway and Secure MCP Tunnel in the foreground')
    .action(() => serve(loadRuntimeConfig()));

  cli.command('status', 'Show service, MCP, and tunnel readiness').action(async () => {
    if (!(await status(loadRuntimeConfig()))) {
      process.exitCode = 1;
    }
  });

  cli.command('workspace list', 'List managed and approved workspaces').action(() => {
    console.log(
      JSON.stringify(
        withWorkspaceServices(({ workspaces }) => workspaces.list(ownerId)),
        null,
        2,
      ),
    );
  });

  cli
    .command('workspace add <path>', 'Register a host workspace')
    .option('--mode <mode>', 'Workspace mode: clone or direct', { default: 'clone' })
    .action((workspacePath: string, options: { mode: string }) => {
      if (options.mode !== 'clone' && options.mode !== 'direct') {
        throw new Error('--mode must be clone or direct');
      }
      console.log(
        JSON.stringify(
          withWorkspaceServices(({ workspaces }) =>
            workspaces.registerHost(ownerId, workspacePath, options.mode as 'clone' | 'direct'),
          ),
          null,
          2,
        ),
      );
    });

  cli.command('approval list', 'List workspace approval requests').action(() => {
    console.log(
      JSON.stringify(
        withWorkspaceServices(({ database }) => database.listApprovals()),
        null,
        2,
      ),
    );
  });

  cli.command('approval approve <id>', 'Approve a workspace request').action((id: string) => {
    console.log(
      JSON.stringify(
        withWorkspaceServices(({ workspaces }) => workspaces.approve(id)),
        null,
        2,
      ),
    );
  });

  cli.command('approval reject <id>', 'Reject a workspace request').action((id: string) => {
    console.log(
      JSON.stringify(
        withWorkspaceServices(({ workspaces }) => workspaces.reject(id)),
        null,
        2,
      ),
    );
  });

  cli.command('help [command]', 'Show help for a command').action((commandName?: string) => {
    if (!commandName) {
      cli.unsetMatchedCommand();
      cli.outputHelp();
      return;
    }
    const command = cli.commands.find((candidate) => candidate.name === commandName);
    if (!command) {
      throw new Error(`Unknown command: ${commandName}`);
    }
    command.outputHelp();
  });

  return cli;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = createCli();
  if (argv.length <= 2) {
    cli.outputHelp();
    return;
  }
  cli.parse(argv, { run: false });
  await cli.runMatchedCommand();
}
