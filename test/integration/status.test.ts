import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { status } from '../../src/cli/status.js';
import { loadRuntimeConfig } from '../../src/config.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('reports a stopped service when no live PID exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2shell-status-'));
  roots.push(root);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  const ready = await status(
    loadRuntimeConfig({
      CHAT2SHELL_DATA_ROOT: path.join(root, '.chat2shell'),
      CHAT2SHELL_ENABLE_TUNNEL: '0',
      CHAT2SHELL_MAX_ACTIVE_SANDBOXES: '2',
    }),
  );

  expect(ready).toBe(false);
  expect(output).toEqual(['Service  stopped', 'Sandboxes 0 active / 2 max']);
});

test('checks the running process and MCP health', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2shell-status-'));
  roots.push(root);
  const server = http.createServer((_request, response) => {
    response.writeHead(200).end('{"status":"ok"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP listener');
  }

  const config = loadRuntimeConfig({
    CHAT2SHELL_DATA_ROOT: path.join(root, '.chat2shell'),
    CHAT2SHELL_ENABLE_TUNNEL: '0',
    CHAT2SHELL_PORT: String(address.port),
  });
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.runtimePidPath, `${process.pid}\n`);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));

  try {
    expect(await status(config)).toBe(true);
    expect(output).toEqual([
      `Service  running (PID ${process.pid})`,
      `MCP      ready at 127.0.0.1:${address.port}`,
      'Tunnel   disabled',
      'Sandboxes 0 active / unlimited max',
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
