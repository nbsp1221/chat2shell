import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { createId } from "../domain/ids.js";
import type { Approval, Sandbox, SandboxCreateResult, SandboxSummary, Workspace, WorkspaceMode } from "../domain/types.js";
import type { StateDatabase } from "../state/database.js";
import type { WorkspaceService } from "../workspaces/service.js";
import type { SandboxDriver } from "./sbx-driver.js";

export interface CreateSandboxRequest {
  readonly workspaceId?: string;
  readonly workspacePath?: string;
  readonly workspaceMode?: WorkspaceMode;
}

function isApproval(value: Workspace | Approval): value is Approval {
  return "requestedPath" in value;
}

export class SandboxService {
  readonly #database: StateDatabase;
  readonly #workspaces: WorkspaceService;
  readonly #driver: SandboxDriver;
  readonly #config: AppConfig;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #destroyListeners = new Set<(sandboxId: string) => Promise<void> | void>();

  constructor(options: {
    database: StateDatabase;
    workspaces: WorkspaceService;
    driver: SandboxDriver;
    config: AppConfig;
    now?: () => number;
  }) {
    this.#database = options.database;
    this.#workspaces = options.workspaces;
    this.#driver = options.driver;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
  }

  onDestroy(listener: (sandboxId: string) => Promise<void> | void): void {
    this.#destroyListeners.add(listener);
  }

  async create(ownerId: string, request: CreateSandboxRequest): Promise<SandboxCreateResult> {
    if (request.workspaceId && request.workspacePath) throw new Error("Specify workspace_id or workspace_path, not both");
    let workspace: Workspace;
    if (request.workspaceId) {
      workspace = this.#workspaces.getApproved(ownerId, request.workspaceId);
      if (request.workspaceMode && request.workspaceMode !== workspace.mode) {
        throw new Error(`workspace_mode=${request.workspaceMode} does not match approved workspace mode ${workspace.mode}`);
      }
    } else if (request.workspacePath) {
      const mode = request.workspaceMode ?? "clone";
      if (mode === "managed") throw new Error("workspace_mode=managed cannot be used with workspace_path");
      const candidate = this.#workspaces.requestHost(ownerId, request.workspacePath, mode);
      if (isApproval(candidate)) return { status: "approval_required", approval: candidate };
      workspace = candidate;
    } else {
      if (request.workspaceMode && request.workspaceMode !== "managed") {
        throw new Error("workspace_mode requires workspace_path or workspace_id");
      }
      workspace = this.#workspaces.createManaged(ownerId);
    }

    const active = this.#database.findActiveSandbox(ownerId, workspace.id);
    if (active?.status === "running") return { status: "reused", sandbox: this.#summarize(active) };
    if (active) throw new Error(`Workspace already has a sandbox in ${active.status} state: ${active.id}`);

    const now = this.#now();
    const id = createId("sbx");
    const sandbox: Sandbox = {
      id,
      ownerId,
      workspaceId: workspace.id,
      runtimeName: `c2s-${id.slice(4, 25)}`,
      status: "creating",
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.#config.idleTimeoutMs,
      maxExpiresAt: now + this.#config.maxLifetimeMs,
    };
    this.#database.insertSandbox(sandbox);

    try {
      const runtime = await this.#driver.create(sandbox.runtimeName, workspace);
      const authToken = randomBytes(32).toString("hex");
      await this.#driver.startCodexPro(sandbox.runtimeName, runtime.runtimeRoot, authToken);
      await this.#driver.waitUntilHealthy(runtime.endpoint, authToken);
      const running: Sandbox = { ...sandbox, ...runtime, authToken, status: "running" };
      this.#database.saveSandbox(running);
      return { status: "created", sandbox: this.#summarize(running) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#driver.remove(sandbox.runtimeName).catch(() => undefined);
      this.#database.saveSandbox({ ...sandbox, status: "failed", error: message, destroyedAt: this.#now() });
      throw error;
    }
  }

  list(ownerId: string): readonly SandboxSummary[] {
    return this.#database.listCurrentSandboxes(ownerId).map((sandbox) => this.#summarize(sandbox));
  }

  get(ownerId: string, sandboxId: string): SandboxSummary {
    const sandbox = this.#database.getSandbox(sandboxId, ownerId);
    if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);
    return this.#summarize(sandbox);
  }

  async readyForTool(ownerId: string, sandboxId: string): Promise<Sandbox> {
    return this.withReady(ownerId, sandboxId, async (sandbox) => sandbox);
  }

  async withReady<T>(ownerId: string, sandboxId: string, operation: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    return this.withLock(sandboxId, async () => {
      const sandbox = this.#database.getSandbox(sandboxId, ownerId);
      if (!sandbox || sandbox.status !== "running" || !sandbox.endpoint || !sandbox.authToken || !sandbox.runtimeRoot) {
        throw new Error(`Sandbox is not running: ${sandboxId}`);
      }
      const now = this.#now();
      if (now >= sandbox.maxExpiresAt) {
        throw new Error(`Sandbox reached its maximum lifetime: ${sandboxId}`);
      }
      if (now >= sandbox.expiresAt) {
        throw new Error(`Sandbox expired after inactivity: ${sandboxId}`);
      }
      if (!(await this.#driver.isHealthy(sandbox.endpoint, sandbox.authToken))) {
        const message = "CodexPro is unavailable; destroy this sandbox and create a new one";
        this.#database.saveSandbox({ ...sandbox, status: "failed", error: message });
        throw new Error(`${message}: ${sandboxId}`);
      }
      const result = await operation(sandbox);
      const completedAt = this.#now();
      this.#database.saveSandbox({
        ...sandbox,
        lastActivityAt: completedAt,
        expiresAt: Math.min(completedAt + this.#config.idleTimeoutMs, sandbox.maxExpiresAt),
      });
      return result;
    });
  }

  async destroy(ownerId: string, sandboxId: string): Promise<SandboxSummary> {
    return this.withLock(sandboxId, async () => {
      const sandbox = this.#database.getSandbox(sandboxId, ownerId);
      if (!sandbox) throw new Error(`Unknown sandbox: ${sandboxId}`);
      if (sandbox.status === "destroyed") return this.#summarize(sandbox);
      this.#database.saveSandbox({ ...sandbox, status: "destroying" });
      try {
        await this.#driver.remove(sandbox.runtimeName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#database.saveSandbox({ ...sandbox, error: `destroy failed: ${message}` });
        throw error;
      }
      for (const listener of this.#destroyListeners) await listener(sandbox.id);
      const destroyedAt = this.#now();
      const destroyed: Sandbox = { ...sandbox, status: "destroyed", destroyedAt, endpoint: undefined, authToken: undefined };
      this.#database.saveSandbox(destroyed);
      const workspace = this.#database.getWorkspace(sandbox.workspaceId);
      if (workspace?.kind === "managed") this.#workspaces.retainManaged(workspace, destroyedAt + this.#config.workspaceRetentionMs);
      return this.#summarize(destroyed);
    });
  }

  async reap(): Promise<{ destroyed: readonly string[]; trashed: readonly string[] }> {
    const now = this.#now();
    const destroyed: string[] = [];
    for (const sandbox of this.#database.listExpiredSandboxes(now)) {
      await this.destroy(sandbox.ownerId, sandbox.id);
      destroyed.push(sandbox.id);
    }
    const trashed = this.#workspaces.trashExpired(now).map((workspace) => workspace.id);
    return { destroyed, trashed };
  }

  async reconcile(): Promise<void> {
    const runtimes = new Map((await this.#driver.list()).map((runtime) => [runtime.name, runtime]));
    for (const sandbox of this.#database.listActiveSandboxes()) {
      const runtime = runtimes.get(sandbox.runtimeName);
      if (sandbox.status === "destroying") {
        if (runtime) await this.#driver.remove(sandbox.runtimeName);
        const destroyedAt = this.#now();
        this.#database.saveSandbox({ ...sandbox, status: "destroyed", endpoint: undefined, authToken: undefined, destroyedAt });
        const workspace = this.#database.getWorkspace(sandbox.workspaceId);
        if (workspace?.kind === "managed") this.#workspaces.retainManaged(workspace, destroyedAt + this.#config.workspaceRetentionMs);
      } else {
        if (runtime) await this.#driver.remove(sandbox.runtimeName);
        this.#database.saveSandbox({
          ...sandbox,
          status: "failed",
          error: "chat2shell restarted; destroy this sandbox and create a new one",
          destroyedAt: this.#now(),
          endpoint: undefined,
          authToken: undefined,
        });
      }
    }
  }

  async withLock<T>(sandboxId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sandboxId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(sandboxId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(sandboxId) === queued) this.#locks.delete(sandboxId);
    }
  }

  #summarize(sandbox: Sandbox): SandboxSummary {
    const workspace = this.#database.getWorkspace(sandbox.workspaceId);
    if (!workspace) throw new Error(`Sandbox ${sandbox.id} references a missing workspace`);
    return {
      id: sandbox.id,
      status: sandbox.status,
      workspace,
      error: sandbox.error,
      createdAt: sandbox.createdAt,
      lastActivityAt: sandbox.lastActivityAt,
      expiresAt: sandbox.expiresAt,
      maxExpiresAt: sandbox.maxExpiresAt,
      destroyedAt: sandbox.destroyedAt,
    };
  }
}
