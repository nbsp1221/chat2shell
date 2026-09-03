import { expect, test } from 'vitest';
import { loadAppConfig } from '../../src/config.js';

test('uses the complete public lifecycle policy', () => {
  const config = loadAppConfig({ HOME: '/tmp/chat2shell-config-test' });

  expect(config.idleTimeoutMs).toBe(24 * 60 * 60_000);
  expect(config.workspaceRetentionMs).toBe(30 * 24 * 60 * 60_000);
  expect('maxLifetimeMs' in config).toBe(false);
  expect('sandboxCpus' in config).toBe(false);
  expect('sandboxMemory' in config).toBe(false);
});
