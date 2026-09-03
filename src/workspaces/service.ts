import fs from 'node:fs';
import path from 'node:path';
import type { Approval, Workspace, WorkspaceMode } from '../domain/types.js';
import type { StateDatabase } from '../state/database.js';
import { createId } from '../domain/ids.js';
import { HostPathPolicy } from './policy.js';

export class WorkspaceService {
  readonly #database: StateDatabase;
  readonly #workspaceRoot: string;
  readonly #trashRoot: string;
  readonly #policy: HostPathPolicy;
  readonly #now: () => number;

  constructor(options: {
    database: StateDatabase;
    workspaceRoot: string;
    dataRoot: string;
    allowedHostRoots: readonly string[];
    now?: () => number;
  }) {
    this.#database = options.database;
    this.#workspaceRoot = options.workspaceRoot;
    this.#trashRoot = path.join(options.dataRoot, 'trash');
    this.#policy = new HostPathPolicy(options.allowedHostRoots);
    this.#now = options.now ?? Date.now;
    fs.mkdirSync(this.#workspaceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.#trashRoot, { recursive: true, mode: 0o700 });
  }

  createManaged(ownerId: string): Workspace {
    const id = createId('ws');
    const root = path.join(this.#workspaceRoot, id);
    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    const workspace: Workspace = {
      id,
      ownerId,
      kind: 'managed',
      mode: 'managed',
      root,
      status: 'approved',
      createdAt: this.#now(),
    };
    try {
      this.#database.insertWorkspace(workspace);
      return workspace;
    } catch (error) {
      fs.rmdirSync(root);
      throw error;
    }
  }

  requestHost(
    ownerId: string,
    requestedPath: string,
    mode: Exclude<WorkspaceMode, 'managed'>,
  ): Workspace | Approval {
    const root = this.#policy.resolveAndValidate(requestedPath);
    const existing = this.#database.findWorkspace(ownerId, root, mode);
    if (existing?.status === 'approved') {
      return existing;
    }
    const pending = this.#database.findPendingApproval(ownerId, root, mode);
    if (pending) {
      return pending;
    }
    const approval: Approval = {
      id: createId('approval'),
      ownerId,
      requestedPath: root,
      mode,
      status: 'pending',
      createdAt: this.#now(),
    };
    this.#database.insertApproval(approval);
    return approval;
  }

  registerHost(
    ownerId: string,
    requestedPath: string,
    mode: Exclude<WorkspaceMode, 'managed'>,
  ): Workspace {
    const root = this.#policy.resolveAndValidate(requestedPath);
    const existing = this.#database.findWorkspace(ownerId, root, mode);
    if (existing) {
      return existing;
    }
    const workspace: Workspace = {
      id: createId('ws'),
      ownerId,
      kind: 'host',
      mode,
      root,
      status: 'approved',
      createdAt: this.#now(),
    };
    this.#database.insertWorkspace(workspace);
    return workspace;
  }

  approve(approvalId: string): Workspace {
    const approval = this.#database.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    if (approval.status !== 'pending') {
      throw new Error(`Approval is already ${approval.status}`);
    }
    const workspace = this.registerHost(approval.ownerId, approval.requestedPath, approval.mode);
    this.#database.decideApproval(approval.id, 'approved', workspace.id, this.#now());
    return workspace;
  }

  reject(approvalId: string): Approval {
    const approval = this.#database.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    if (approval.status !== 'pending') {
      throw new Error(`Approval is already ${approval.status}`);
    }
    const decidedAt = this.#now();
    this.#database.decideApproval(approval.id, 'rejected', undefined, decidedAt);
    return { ...approval, status: 'rejected', decidedAt };
  }

  getApproved(ownerId: string, workspaceId: string): Workspace {
    const workspace = this.#database.getWorkspace(workspaceId, ownerId);
    if (!workspace || workspace.status === 'trashed') {
      throw new Error(`Unknown or unavailable workspace: ${workspaceId}`);
    }
    if (workspace.status === 'retained') {
      this.#database.updateWorkspaceStatus(workspace.id, 'approved');
      return { ...workspace, status: 'approved', retainedUntil: undefined };
    }
    return workspace;
  }

  list(ownerId: string): readonly Workspace[] {
    return this.#database.listWorkspaces(ownerId);
  }

  retainManaged(workspace: Workspace, retainedUntil: number): Workspace {
    if (workspace.kind !== 'managed') {
      return workspace;
    }
    this.#database.updateWorkspaceStatus(workspace.id, 'retained', retainedUntil);
    return { ...workspace, status: 'retained', retainedUntil };
  }

  trashExpired(now = this.#now()): readonly Workspace[] {
    const trashed: Workspace[] = [];
    for (const workspace of this.#database.listExpiredRetainedWorkspaces(now)) {
      if (workspace.kind !== 'managed') {
        continue;
      }
      const source = fs.realpathSync.native(workspace.root);
      const workspaceRoot = fs.realpathSync.native(this.#workspaceRoot);
      if (path.dirname(source) !== workspaceRoot || path.basename(source) !== workspace.id) {
        throw new Error(`Refusing to trash unexpected managed path: ${source}`);
      }
      const destination = path.join(this.#trashRoot, `${workspace.id}-${now}`);
      fs.renameSync(source, destination);
      this.#database.updateWorkspaceLocation(workspace.id, destination, 'trashed');
      trashed.push({
        ...workspace,
        root: destination,
        status: 'trashed',
        retainedUntil: undefined,
      });
    }
    return trashed;
  }
}
