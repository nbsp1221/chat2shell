import { readFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../config.js';

async function isReady(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function runningPid(config: RuntimeConfig): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(config.runtimePidPath, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return undefined;
    }
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export async function status(config: RuntimeConfig): Promise<boolean> {
  const pid = await runningPid(config);
  if (!pid) {
    console.log('Service  stopped');
    return false;
  }

  const mcpReady = await isReady(`http://${config.host}:${config.port}/healthz`);
  let tunnelState = 'disabled';
  if (config.tunnelEnabled) {
    try {
      const healthUrl = (await readFile(config.tunnelHealthUrlPath, 'utf8')).trim();
      tunnelState = (await isReady(`${healthUrl}/readyz`)) ? 'ready' : 'not ready';
    } catch {
      tunnelState = 'not ready';
    }
  }

  console.log(`Service  running (PID ${pid})`);
  console.log(`MCP      ${mcpReady ? `ready at ${config.host}:${config.port}` : 'not ready'}`);
  console.log(`Tunnel   ${tunnelState}`);
  return mcpReady && tunnelState !== 'not ready';
}
