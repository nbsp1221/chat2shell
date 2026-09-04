import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { loadAppConfig } from '../../src/config.js';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function environment(): Promise<{ hostRoot: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2shell-cli-'));
  const hostRoot = path.join(root, 'repositories');
  await mkdir(hostRoot);
  roots.push(root);
  vi.stubEnv('CHAT2SHELL_DATA_ROOT', path.join(root, 'data'));
  vi.stubEnv('CHAT2SHELL_ALLOWED_HOST_ROOTS', hostRoot);
  return { hostRoot, root };
}

test('executes workspace list and add commands', async () => {
  const { hostRoot } = await environment();
  const repository = path.join(hostRoot, 'project');
  await mkdir(repository);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  await runCli(['node', 'chat2shell', 'workspace', 'list']);
  expect(JSON.parse(output.pop() ?? '')).toEqual([]);

  await runCli(['node', 'chat2shell', 'workspace', 'add', repository, '--mode', 'direct']);
  expect(JSON.parse(output.pop() ?? '')).toMatchObject({ mode: 'direct', root: repository });

  await runCli(['node', 'chat2shell', 'workspace', 'list']);
  expect(JSON.parse(output.pop() ?? '')).toEqual([
    expect.objectContaining({ mode: 'direct', root: repository }),
  ]);
});

test('executes approval list, approve, and reject commands', async () => {
  const { hostRoot } = await environment();
  const approvePath = path.join(hostRoot, 'approve');
  const rejectPath = path.join(hostRoot, 'reject');
  await Promise.all([mkdir(approvePath), mkdir(rejectPath)]);
  const config = loadAppConfig();
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    allowedHostRoots: config.allowedHostRoots,
    database,
    dataRoot: config.dataRoot,
    workspaceRoot: config.workspaceRoot,
  });
  const approve = workspaces.requestHost('local-owner', approvePath, 'clone');
  const reject = workspaces.requestHost('local-owner', rejectPath, 'direct');
  database.close();
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  await runCli(['node', 'chat2shell', 'approval', 'list']);
  expect(JSON.parse(output.pop() ?? '')).toHaveLength(2);

  await runCli(['node', 'chat2shell', 'approval', 'approve', approve.id]);
  expect(JSON.parse(output.pop() ?? '')).toMatchObject({ mode: 'clone', root: approvePath });

  await runCli(['node', 'chat2shell', 'approval', 'reject', reject.id]);
  expect(JSON.parse(output.pop() ?? '')).toMatchObject({ id: reject.id, status: 'rejected' });
});

test('rejects unknown commands and management actions', async () => {
  await environment();

  await expect(runCli(['node', 'chat2shell', 'does-not-exist'])).rejects.toThrow(
    'Unknown command: does-not-exist',
  );
  await expect(runCli(['node', 'chat2shell', 'workspace', 'remove'])).rejects.toThrow(
    'Unknown workspace action: remove',
  );
  await expect(runCli(['node', 'chat2shell', 'approval', 'approve'])).rejects.toThrow(
    'approval approve requires an ID',
  );
});
