import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { StateDatabase } from '../../src/state/database.js';
import { WorkspaceService } from '../../src/workspaces/service.js';

function fixture(): { base: string; database: StateDatabase; service: WorkspaceService } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-workspaces-'));
  const allowedRoot = path.join(base, 'allowed');
  fs.mkdirSync(allowedRoot);
  const database = new StateDatabase(':memory:');
  const service = new WorkspaceService({
    allowedHostRoots: [allowedRoot],
    dataRoot: path.join(base, 'data'),
    database,
    now: () => 1_000,
    workspaceRoot: path.join(base, 'data', 'workspaces'),
  });
  onTestFinished(() => {
    database.close();
    fs.rmSync(base, { force: true, recursive: true });
  });
  return { base, database, service };
}

test('managed workspaces have an independent stable id and private directory', () => {
  const { service } = fixture();
  const workspace = service.createManaged('owner');

  expect(workspace.id).toMatch(/^ws_/);
  expect(path.basename(workspace.root)).toBe(workspace.id);
  expect(fs.statSync(workspace.root).mode & 0o777).toBe(0o700);
});

test('a host path becomes only a pending approval until approved locally', () => {
  const { base, service } = fixture();
  const repository = path.join(base, 'allowed', 'repo');
  fs.mkdirSync(repository);

  const request = service.requestHost('owner', repository, 'direct');
  expect(request.status).toBe('pending');
  expect('requestedPath' in request).toBe(true);

  const workspace = service.approve(request.id);
  expect(workspace.kind).toBe('host');
  expect(workspace.mode).toBe('direct');
  expect(workspace.root).toBe(repository);
});

test('paths outside allow roots and protected paths are rejected', () => {
  const { base, service } = fixture();
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);

  expect(() => service.requestHost('owner', outside, 'clone')).toThrow(/allowed host root/);

  const protectedPath = path.join(base, 'allowed', '.ssh', 'repo');
  fs.mkdirSync(protectedPath, { recursive: true });
  expect(() => service.requestHost('owner', protectedPath, 'direct')).toThrow(
    /protected directory/,
  );
});

test('retained managed workspaces can be attached to a new sandbox before trashing', () => {
  const { service } = fixture();
  const workspace = service.createManaged('owner');
  service.retainManaged(workspace, 10_000);

  const restored = service.getApproved('owner', workspace.id);
  expect(restored.status).toBe('approved');
  expect(restored.root).toBe(workspace.root);
});
