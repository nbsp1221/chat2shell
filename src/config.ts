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
  readonly sandboxCpus: number;
  readonly sandboxMemory: string;
  readonly sandboxPort: number;
  readonly idleTimeoutMs: number;
  readonly maxLifetimeMs: number;
  readonly workspaceRetentionMs: number;
  readonly reaperIntervalMs: number;
  readonly codexProToolMode: "minimal" | "standard" | "full";
}

function readInteger(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = readInteger(value, fallback, name);
  if (port > 65_535) throw new Error(`${name} must be no greater than 65535`);
  return port;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function resolvePath(value: string): string {
  return path.resolve(expandHome(value));
}

function readToolMode(value: string | undefined): AppConfig["codexProToolMode"] {
  if (value === undefined) return "standard";
  if (value === "minimal" || value === "standard" || value === "full") return value;
  throw new Error("CHAT2SHELL_CODEXPRO_TOOL_MODE must be minimal, standard, or full");
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
    maxBodyBytes: readInteger(environment.CHAT2SHELL_MAX_BODY_BYTES, 20 * 1024 * 1024, "CHAT2SHELL_MAX_BODY_BYTES"),
    dataRoot,
    workspaceRoot,
    stateDir,
    databasePath: resolvePath(environment.CHAT2SHELL_DATABASE_PATH ?? path.join(stateDir, "chat2shell.sqlite")),
    allowedHostRoots,
    sbxBinary: environment.CHAT2SHELL_SBX_BINARY ?? "sbx",
    sandboxTemplate: environment.CHAT2SHELL_SANDBOX_TEMPLATE ?? "chat2shell-codexpro:0.30.0",
    sandboxCpus: readInteger(environment.CHAT2SHELL_SANDBOX_CPUS, 2, "CHAT2SHELL_SANDBOX_CPUS"),
    sandboxMemory: environment.CHAT2SHELL_SANDBOX_MEMORY ?? "4g",
    sandboxPort: readPort(environment.CHAT2SHELL_SANDBOX_PORT, 18_787, "CHAT2SHELL_SANDBOX_PORT"),
    idleTimeoutMs: readInteger(environment.CHAT2SHELL_IDLE_TIMEOUT_MS, 30 * 60_000, "CHAT2SHELL_IDLE_TIMEOUT_MS"),
    maxLifetimeMs: readInteger(environment.CHAT2SHELL_MAX_LIFETIME_MS, 4 * 60 * 60_000, "CHAT2SHELL_MAX_LIFETIME_MS"),
    workspaceRetentionMs: readInteger(environment.CHAT2SHELL_WORKSPACE_RETENTION_MS, 7 * 24 * 60 * 60_000, "CHAT2SHELL_WORKSPACE_RETENTION_MS"),
    reaperIntervalMs: readInteger(environment.CHAT2SHELL_REAPER_INTERVAL_MS, 60_000, "CHAT2SHELL_REAPER_INTERVAL_MS"),
    codexProToolMode: readToolMode(environment.CHAT2SHELL_CODEXPRO_TOOL_MODE),
  };
}
