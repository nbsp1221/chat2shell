import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { loadAppConfig, loadRuntimeConfig } from '../../src/config.js';

test('uses the complete public lifecycle policy', () => {
  const config = loadAppConfig({ HOME: '/tmp/chat2shell-config-test' });

  expect(config.idleTimeoutMs).toBe(24 * 60 * 60_000);
  expect(config.workspaceRetentionMs).toBe(30 * 24 * 60 * 60_000);
  expect('maxLifetimeMs' in config).toBe(false);
  expect('sandboxCpus' in config).toBe(false);
  expect('sandboxMemory' in config).toBe(false);
  expect(config.maxActiveSandboxes).toBeUndefined();
});

test('loads the sandbox count limit from config.json with an environment override', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-config-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  fs.writeFileSync(path.join(dataRoot, 'config.json'), '{"maxActiveSandboxes":3}\n');

  expect(loadAppConfig({ CHAT2SHELL_DATA_ROOT: dataRoot }).maxActiveSandboxes).toBe(3);
  expect(
    loadAppConfig({
      CHAT2SHELL_DATA_ROOT: dataRoot,
      CHAT2SHELL_MAX_ACTIVE_SANDBOXES: '1',
    }).maxActiveSandboxes,
  ).toBe(1);
  expect(
    loadAppConfig({
      CHAT2SHELL_DATA_ROOT: dataRoot,
      CHAT2SHELL_MAX_ACTIVE_SANDBOXES: 'unlimited',
    }).maxActiveSandboxes,
  ).toBeUndefined();
});

test('rejects invalid sandbox count limits', () => {
  expect(() => loadAppConfig({ CHAT2SHELL_MAX_ACTIVE_SANDBOXES: '-1' })).toThrow(
    /non-negative integer or unlimited/,
  );
});

test('rejects unknown config.json settings instead of silently ignoring typos', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-config-'));
  onTestFinished(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  fs.writeFileSync(path.join(dataRoot, 'config.json'), '{"maxActiveSandbox":3}\n');

  expect(() => loadAppConfig({ CHAT2SHELL_DATA_ROOT: dataRoot })).toThrow(/unknown setting/);
});

test('uses the documented runtime locations without enabling extra service policy', () => {
  const config = loadRuntimeConfig({
    CHAT2SHELL_DATA_ROOT: '/tmp/chat2shell-config-test/.chat2shell',
  });

  expect(config.runtimePidPath).toBe('/tmp/chat2shell-config-test/.chat2shell/state/runtime.pid');
  expect(config.tunnelHealthUrlPath).toBe(
    '/tmp/chat2shell-config-test/.chat2shell/state/health.url',
  );
  expect(config.tunnelEnabled).toBe(true);
  expect('restart' in config).toBe(false);
});
