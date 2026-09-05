import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type {
  Approval,
  Sandbox,
  SandboxCreateResult,
  SandboxPortExposure,
  SandboxSummary,
  Workspace,
  WorkspaceMode,
} from '../domain/types.js';
import type { StateDatabase } from '../state/database.js';
import type { WorkspaceService } from '../workspaces/service.js';
import { createId } from '../domain/ids.js';
import type { SandboxDriver } from './sbx-driver.js';
import { formatMemory, parseMemory } from './memory.js';

export interface CreateSandboxRequest {
  readonly workspaceId?: string;
  readonly workspacePath?: string;
  readonly workspaceMode?: WorkspaceMode;
  readonly memory?: string;
}

function isApproval(value: Workspace | Approval): value is Approval {
  return 'requestedPath' in value;
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
    if (request.workspaceId && request.workspacePath) {
      throw new Error('Specify workspace_id or workspace_path, not both');
    }
    const memoryBytes = request.memory ? parseMemory(request.memory) : undefined;
    let workspace: Workspace;
    if (request.workspaceId) {
      workspace = this.#workspaces.getApproved(ownerId, request.workspaceId);
      if (request.workspaceMode && request.workspaceMode !== workspace.mode) {
        throw new Error(
          `workspace_mode=${request.workspaceMode} does not match approved workspace mode ${workspace.mode}`,
        );
      }
    } else if (request.workspacePath) {
      const mode = request.workspaceMode ?? 'clone';
      if (mode === 'managed') {
        throw new Error('workspace_mode=managed cannot be used with workspace_path');
      }
      const candidate = this.#workspaces.requestHost(ownerId, request.workspacePath, mode);
      if (isApproval(candidate)) {
        return { status: 'approval_required', approval: candidate };
      }
      workspace = candidate;
    } else {
      if (request.workspaceMode && request.workspaceMode !== 'managed') {
        throw new Error('workspace_mode requires workspace_path or workspace_id');
      }
      if (
        this.#config.maxActiveSandboxes !== undefined &&
        this.#database.countActiveSandboxes() >= this.#config.maxActiveSandboxes
      ) {
        throw this.#sandboxLimitError();
      }
      workspace = this.#workspaces.createManaged(ownerId);
    }

    const active = this.#database.findActiveSandbox(ownerId, workspace.id);
    if (active?.status === 'running') {
      if (memoryBytes !== undefined && memoryBytes !== active.memoryBytes) {
        throw new Error(
          `Workspace already has sandbox ${active.id} with memory=${active.memoryBytes === undefined ? 'default' : formatMemory(active.memoryBytes)}; destroy it before changing memory`,
        );
      }
      return { status: 'reused', sandbox: this.#summarize(active) };
    }
    if (active) {
      throw new Error(`Workspace already has a sandbox in ${active.status} state: ${active.id}`);
    }

    const now = this.#now();
    const id = createId('sbx');
    const sandbox: Sandbox = {
      id,
      ownerId,
      workspaceId: workspace.id,
      runtimeName: `c2s-${id.slice(4, 25)}`,
      status: 'creating',
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.#config.idleTimeoutMs,
      memoryBytes,
    };
    if (!this.#database.insertSandboxWithinLimit(sandbox, this.#config.maxActiveSandboxes)) {
      throw this.#sandboxLimitError();
    }

    try {
      const runtime = await this.#driver.create(sandbox.runtimeName, workspace, memoryBytes);
      const authToken = randomBytes(32).toString('hex');
      await this.#driver.startCodexPro(sandbox.runtimeName, runtime.runtimeRoot, authToken);
      await this.#driver.waitUntilHealthy(runtime.endpoint, authToken);
      const running: Sandbox = { ...sandbox, ...runtime, authToken, status: 'running' };
      this.#database.saveSandbox(running);
      return { status: 'created', sandbox: this.#summarize(running) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#driver.remove(sandbox.runtimeName).catch(() => undefined);
      const destroyedAt = this.#now();
      this.#database.saveSandbox({ ...sandbox, status: 'failed', error: message, destroyedAt });
      this.#retainManagedWorkspace(sandbox.workspaceId, destroyedAt);
      throw error;
    }
  }

  list(ownerId: string): readonly SandboxSummary[] {
    return this.#database.listCurrentSandboxes(ownerId).map((sandbox) => this.#summarize(sandbox));
  }

  get(ownerId: string, sandboxId: string): SandboxSummary {
    const sandbox = this.#database.getSandbox(sandboxId, ownerId);
    if (!sandbox) {
      throw new Error(`Unknown sandbox: ${sandboxId}`);
    }
    return this.#summarize(sandbox);
  }

  async readyForTool(ownerId: string, sandboxId: string): Promise<Sandbox> {
    return this.withReady(ownerId, sandboxId, (sandbox) => Promise.resolve(sandbox));
  }

  async expose(ownerId: string, sandboxId: string, port: number): Promise<SandboxPortExposure> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('port must be an integer from 1 to 65535');
    }
    return this.withReady(ownerId, sandboxId, async (sandbox) => {
      const published = await this.#driver.expose(sandbox.runtimeName, port);
      return { sandboxId, ...published };
    });
  }

  async withReady<T>(
    ownerId: string,
    sandboxId: string,
    operation: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> {
    return this.withLock(sandboxId, async () => {
      const sandbox = this.#database.getSandbox(sandboxId, ownerId);
      if (
        !sandbox ||
        sandbox.status !== 'running' ||
        !sandbox.endpoint ||
        !sandbox.authToken ||
        !sandbox.runtimeRoot
      ) {
        throw new Error(`Sandbox is not running: ${sandboxId}`);
      }
      const now = this.#now();
      if (now >= sandbox.expiresAt) {
        throw new Error(`Sandbox expired after inactivity: ${sandboxId}`);
      }
      if (!(await this.#driver.isHealthy(sandbox.endpoint, sandbox.authToken))) {
        const message = 'CodexPro is unavailable; destroy this sandbox and create a new one';
        this.#database.saveSandbox({ ...sandbox, status: 'failed', error: message });
        throw new Error(`${message}: ${sandboxId}`);
      }
      try {
        return await operation(sandbox);
      } finally {
        const completedAt = this.#now();
        this.#database.saveSandbox({
          ...sandbox,
          lastActivityAt: completedAt,
          expiresAt: completedAt + this.#config.idleTimeoutMs,
        });
      }
    });
  }

  async destroy(ownerId: string, sandboxId: string): Promise<SandboxSummary> {
    return this.withLock(sandboxId, async () => {
      const sandbox = this.#database.getSandbox(sandboxId, ownerId);
      if (!sandbox) {
        throw new Error(`Unknown sandbox: ${sandboxId}`);
      }
      if (sandbox.status === 'destroyed') {
        return this.#summarize(sandbox);
      }
      return this.#removeSandbox(sandbox);
    });
  }

  async reap(): Promise<{ destroyed: readonly string[]; trashed: readonly string[] }> {
    const destroyed: string[] = [];
    for (const candidate of this.#database.listExpiredSandboxes(this.#now())) {
      await this.withLock(candidate.id, async () => {
        const sandbox = this.#database.getSandbox(candidate.id, candidate.ownerId);
        if (!sandbox || sandbox.status !== 'running' || sandbox.expiresAt > this.#now()) {
          return;
        }
        await this.#removeSandbox(sandbox);
        destroyed.push(sandbox.id);
      });
    }
    const trashed = this.#workspaces.trashExpired(this.#now()).map((workspace) => workspace.id);
    return { destroyed, trashed };
  }

  async reconcile(): Promise<void> {
    const runtimes = new Map((await this.#driver.list()).map((runtime) => [runtime.name, runtime]));
    for (const sandbox of this.#database.listActiveSandboxes()) {
      const runtime = runtimes.get(sandbox.runtimeName);
      if (sandbox.status === 'destroying') {
        if (runtime) {
          await this.#driver.remove(sandbox.runtimeName);
        }
        const destroyedAt = this.#now();
        this.#database.saveSandbox({
          ...sandbox,
          status: 'destroyed',
          endpoint: undefined,
          authToken: undefined,
          destroyedAt,
        });
        this.#retainManagedWorkspace(sandbox.workspaceId, destroyedAt);
      } else {
        if (runtime) {
          await this.#driver.remove(sandbox.runtimeName);
        }
        const destroyedAt = this.#now();
        this.#database.saveSandbox({
          ...sandbox,
          status: 'failed',
          error: 'chat2shell restarted; destroy this sandbox and create a new one',
          destroyedAt,
          endpoint: undefined,
          authToken: undefined,
        });
        this.#retainManagedWorkspace(sandbox.workspaceId, destroyedAt);
      }
    }
  }

  async withLock<T>(sandboxId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sandboxId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(sandboxId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(sandboxId) === queued) {
        this.#locks.delete(sandboxId);
      }
    }
  }

  #retainManagedWorkspace(workspaceId: string, removedAt: number): void {
    const workspace = this.#database.getWorkspace(workspaceId);
    if (workspace?.kind === 'managed') {
      this.#workspaces.retainManaged(workspace, removedAt + this.#config.workspaceRetentionMs);
    }
  }

  #sandboxLimitError(): Error {
    return new Error(
      `Active sandbox limit reached: ${String(this.#config.maxActiveSandboxes)} maximum`,
    );
  }

  async #removeSandbox(sandbox: Sandbox): Promise<SandboxSummary> {
    this.#database.saveSandbox({ ...sandbox, status: 'destroying' });
    try {
      await this.#driver.remove(sandbox.runtimeName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#database.saveSandbox({ ...sandbox, error: `destroy failed: ${message}` });
      throw error;
    }
    for (const listener of this.#destroyListeners) {
      await listener(sandbox.id);
    }
    const destroyedAt = this.#now();
    const destroyed: Sandbox = {
      ...sandbox,
      status: 'destroyed',
      destroyedAt,
      endpoint: undefined,
      authToken: undefined,
    };
    this.#database.saveSandbox(destroyed);
    this.#retainManagedWorkspace(sandbox.workspaceId, destroyedAt);
    return this.#summarize(destroyed);
  }

  #summarize(sandbox: Sandbox): SandboxSummary {
    const workspace = this.#database.getWorkspace(sandbox.workspaceId);
    if (!workspace) {
      throw new Error(`Sandbox ${sandbox.id} references a missing workspace`);
    }
    return {
      id: sandbox.id,
      status: sandbox.status,
      workspace,
      error: sandbox.error,
      createdAt: sandbox.createdAt,
      lastActivityAt: sandbox.lastActivityAt,
      expiresAt: sandbox.expiresAt,
      destroyedAt: sandbox.destroyedAt,
      memory: sandbox.memoryBytes === undefined ? null : formatMemory(sandbox.memoryBytes),
    };
  }
}
