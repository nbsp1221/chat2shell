import os from "node:os";
import path from "node:path";

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
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function resolvePath(value: string): string {
  return path.resolve(expandHome(value));
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataRoot = resolvePath(environment.CHAT2SHELL_DATA_ROOT ?? "~/.chat2shell");
  const stateDir = resolvePath(environment.CHAT2SHELL_STATE_DIR ?? path.join(dataRoot, "state"));
  const workspaceRoot = resolvePath(environment.CHAT2SHELL_WORKSPACE_ROOT ?? path.join(dataRoot, "workspaces"));
  const defaultAllowedRoot = path.join(os.homedir(), "repositories");
  const allowedHostRoots = (environment.CHAT2SHELL_ALLOWED_HOST_ROOTS ?? defaultAllowedRoot)
    .split(path.delimiter)
    .filter(Boolean)
    .map(resolvePath);

  return {
    host: environment.CHAT2SHELL_HOST ?? "127.0.0.1",
    port: readPort(environment.CHAT2SHELL_PORT, 18_788, "CHAT2SHELL_PORT"),
    maxBodyBytes: 20 * 1024 * 1024,
    dataRoot,
    workspaceRoot,
    stateDir,
    databasePath: resolvePath(environment.CHAT2SHELL_DATABASE_PATH ?? path.join(stateDir, "chat2shell.sqlite")),
    allowedHostRoots,
    sbxBinary: "sbx",
    sandboxTemplate: "chat2shell-codexpro:0.30.0",
    sandboxPort: 18_787,
    idleTimeoutMs: 24 * 60 * 60_000,
    workspaceRetentionMs: 30 * 24 * 60 * 60_000,
    reaperIntervalMs: 60_000,
  };
}
