import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly allowedHostRoots: readonly string[];
  readonly sbxBinary: string;
  readonly sandboxTemplate: string;
  readonly sandboxPort: number;
  readonly idleTimeoutMs: number;
  readonly workspaceRetentionMs: number;
  readonly reaperIntervalMs: number;
  readonly maxActiveSandboxes?: number;
}

export interface RuntimeConfig extends AppConfig {
  readonly runtimePidPath: string;
  readonly tunnelEnabled: boolean;
  readonly tunnelClient: string;
  readonly tunnelKeyPath: string;
  readonly tunnelIdPath: string;
  readonly tunnelHealthUrlPath: string;
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function resolvePath(value: string): string {
  return path.resolve(expandHome(value));
}

interface FileConfig {
  readonly maxActiveSandboxes?: number;
}

function readFileConfig(dataRoot: string): FileConfig {
  const configPath = path.join(dataRoot, 'config.json');
  let source: string;
  try {
    source = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  const values = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(values).filter((key) => key !== 'maxActiveSandboxes');
  if (unknownKeys.length > 0) {
    throw new Error(`${configPath} contains unknown setting: ${String(unknownKeys[0])}`);
  }
  const maxActiveSandboxes = values.maxActiveSandboxes;
  if (
    maxActiveSandboxes !== undefined &&
    (!Number.isSafeInteger(maxActiveSandboxes) || Number(maxActiveSandboxes) < 0)
  ) {
    throw new Error(`${configPath} maxActiveSandboxes must be a non-negative integer`);
  }
  return { maxActiveSandboxes: maxActiveSandboxes as number | undefined };
}

function readMaxActiveSandboxes(value: string | undefined, fileValue?: number): number | undefined {
  if (value === undefined) {
    return fileValue;
  }
  if (value === 'unlimited') {
    return undefined;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0 || value.trim() === '') {
    throw new Error('CHAT2SHELL_MAX_ACTIVE_SANDBOXES must be a non-negative integer or unlimited');
  }
  return limit;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataRoot = resolvePath(environment.CHAT2SHELL_DATA_ROOT ?? '~/.chat2shell');
  const fileConfig = readFileConfig(dataRoot);
  const stateDir = resolvePath(environment.CHAT2SHELL_STATE_DIR ?? path.join(dataRoot, 'state'));
  const workspaceRoot = resolvePath(
    environment.CHAT2SHELL_WORKSPACE_ROOT ?? path.join(dataRoot, 'workspaces'),
  );
  const defaultAllowedRoot = path.join(os.homedir(), 'repositories');
  const allowedHostRoots = (environment.CHAT2SHELL_ALLOWED_HOST_ROOTS ?? defaultAllowedRoot)
    .split(path.delimiter)
    .filter(Boolean)
    .map(resolvePath);

  return {
    host: environment.CHAT2SHELL_HOST ?? '127.0.0.1',
    port: readPort(environment.CHAT2SHELL_PORT, 18_788, 'CHAT2SHELL_PORT'),
    maxBodyBytes: 20 * 1024 * 1024,
    dataRoot,
    workspaceRoot,
    stateDir,
    databasePath: resolvePath(
      environment.CHAT2SHELL_DATABASE_PATH ?? path.join(stateDir, 'chat2shell.sqlite'),
    ),
    allowedHostRoots,
    sbxBinary: 'sbx',
    sandboxTemplate: 'chat2shell-codexpro:0.30.0',
    sandboxPort: 18_787,
    idleTimeoutMs: 24 * 60 * 60_000,
    workspaceRetentionMs: 30 * 24 * 60 * 60_000,
    reaperIntervalMs: 60_000,
    maxActiveSandboxes: readMaxActiveSandboxes(
      environment.CHAT2SHELL_MAX_ACTIVE_SANDBOXES,
      fileConfig.maxActiveSandboxes,
    ),
  };
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const config = loadAppConfig(environment);
  const tunnelSecretDir = resolvePath(
    environment.CHAT2SHELL_SECRET_DIR ?? '~/.secrets/tunnel-client',
  );
  return {
    ...config,
    runtimePidPath: path.join(config.stateDir, 'runtime.pid'),
    tunnelEnabled: environment.CHAT2SHELL_ENABLE_TUNNEL !== '0',
    tunnelClient: resolvePath(environment.CHAT2SHELL_TUNNEL_CLIENT ?? '~/.local/bin/tunnel-client'),
    tunnelKeyPath: path.join(tunnelSecretDir, 'key'),
    tunnelIdPath: path.join(tunnelSecretDir, 'tunnel-id'),
    tunnelHealthUrlPath: path.join(config.stateDir, 'health.url'),
  };
}
