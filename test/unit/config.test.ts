import { expect, test } from 'vitest';
import { loadAppConfig, loadRuntimeConfig } from '../../src/config.js';

test('uses the complete public lifecycle policy', () => {
  const config = loadAppConfig({ HOME: '/tmp/chat2shell-config-test' });

  expect(config.idleTimeoutMs).toBe(24 * 60 * 60_000);
  expect(config.workspaceRetentionMs).toBe(30 * 24 * 60 * 60_000);
  expect('maxLifetimeMs' in config).toBe(false);
  expect('sandboxCpus' in config).toBe(false);
  expect('sandboxMemory' in config).toBe(false);
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
