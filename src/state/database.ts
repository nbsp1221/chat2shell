import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Approval, Sandbox, SandboxStatus, Workspace } from '../domain/types.js';

type SqlValue = string | number | null;

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function workspaceFromRow(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: row.kind as Workspace['kind'],
    mode: row.mode as Workspace['mode'],
    root: String(row.root),
    status: row.status as Workspace['status'],
    createdAt: Number(row.created_at),
    retainedUntil: optionalNumber(row.retained_until),
  };
}

function approvalFromRow(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    requestedPath: String(row.requested_path),
    mode: row.mode as Approval['mode'],
    status: row.status as Approval['status'],
    workspaceId: optionalString(row.workspace_id),
    createdAt: Number(row.created_at),
    decidedAt: optionalNumber(row.decided_at),
  };
}

function sandboxFromRow(row: Record<string, unknown>): Sandbox {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    workspaceId: String(row.workspace_id),
    runtimeName: String(row.runtime_name),
    runtimeRoot: optionalString(row.runtime_root),
    status: row.status as SandboxStatus,
    endpoint: optionalString(row.endpoint),
    authToken: optionalString(row.auth_token),
    error: optionalString(row.error),
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
    expiresAt: Number(row.expires_at),
    destroyedAt: optionalNumber(row.destroyed_at),
    memoryBytes: optionalNumber(row.memory_bytes),
  };
}

export class StateDatabase {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') {
      fs.chmodSync(databasePath, 0o600);
    }
    this.#database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('managed', 'host')),
        mode TEXT NOT NULL CHECK (mode IN ('managed', 'clone', 'direct')),
        root TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'retained', 'trashed')),
        created_at INTEGER NOT NULL,
        retained_until INTEGER,
        UNIQUE(owner_id, root, mode)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        requested_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('clone', 'direct')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        workspace_id TEXT REFERENCES workspaces(id),
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_path_approval
        ON approvals(owner_id, requested_path, mode) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        runtime_name TEXT NOT NULL UNIQUE,
        runtime_root TEXT,
        status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'destroying', 'destroyed', 'failed')),
        endpoint TEXT,
        auth_token TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        destroyed_at INTEGER,
        memory_bytes INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_sandbox_per_workspace
        ON sandboxes(owner_id, workspace_id) WHERE status IN ('creating', 'running', 'destroying');
    `);
  }

  insertWorkspace(workspace: Workspace): void {
    this.#database
      .prepare(`INSERT INTO workspaces
      (id, owner_id, kind, mode, root, status, created_at, retained_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workspace.id,
        workspace.ownerId,
        workspace.kind,
        workspace.mode,
        workspace.root,
        workspace.status,
        workspace.createdAt,
        workspace.retainedUntil ?? null,
      );
  }

  updateWorkspaceStatus(id: string, status: Workspace['status'], retainedUntil?: number): void {
    this.#database
      .prepare('UPDATE workspaces SET status = ?, retained_until = ? WHERE id = ?')
      .run(status, retainedUntil ?? null, id);
  }

  updateWorkspaceLocation(
    id: string,
    root: string,
    status: Workspace['status'],
    retainedUntil?: number,
  ): void {
    this.#database
      .prepare('UPDATE workspaces SET root = ?, status = ?, retained_until = ? WHERE id = ?')
      .run(root, status, retainedUntil ?? null, id);
  }

  getWorkspace(id: string, ownerId?: string): Workspace | undefined {
    const row = ownerId
      ? this.#database
          .prepare('SELECT * FROM workspaces WHERE id = ? AND owner_id = ?')
          .get(id, ownerId)
      : this.#database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return row ? workspaceFromRow(row) : undefined;
  }

  findWorkspace(ownerId: string, root: string, mode: Workspace['mode']): Workspace | undefined {
    const row = this.#database
      .prepare('SELECT * FROM workspaces WHERE owner_id = ? AND root = ? AND mode = ?')
      .get(ownerId, root, mode);
    return row ? workspaceFromRow(row) : undefined;
  }

  listWorkspaces(ownerId: string): readonly Workspace[] {
    return this.#database
      .prepare('SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId)
      .map(workspaceFromRow);
  }

  listExpiredRetainedWorkspaces(now: number): readonly Workspace[] {
    return this.#database
      .prepare("SELECT * FROM workspaces WHERE status = 'retained' AND retained_until <= ?")
      .all(now)
      .map(workspaceFromRow);
  }

  insertApproval(approval: Approval): void {
    this.#database
      .prepare(`INSERT INTO approvals
      (id, owner_id, requested_path, mode, status, workspace_id, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        approval.id,
        approval.ownerId,
        approval.requestedPath,
        approval.mode,
        approval.status,
        approval.workspaceId ?? null,
        approval.createdAt,
        approval.decidedAt ?? null,
      );
  }

  getApproval(id: string): Approval | undefined {
    const row = this.#database.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return row ? approvalFromRow(row) : undefined;
  }

  findPendingApproval(
    ownerId: string,
    requestedPath: string,
    mode: Approval['mode'],
  ): Approval | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM approvals WHERE owner_id = ? AND requested_path = ? AND mode = ? AND status = 'pending'",
      )
      .get(ownerId, requestedPath, mode);
    return row ? approvalFromRow(row) : undefined;
  }

  decideApproval(
    id: string,
    status: 'approved' | 'rejected',
    workspaceId: string | undefined,
    decidedAt: number,
  ): void {
    this.#database
      .prepare('UPDATE approvals SET status = ?, workspace_id = ?, decided_at = ? WHERE id = ?')
      .run(status, workspaceId ?? null, decidedAt, id);
  }

  listApprovals(status?: Approval['status']): readonly Approval[] {
    const rows = status
      ? this.#database
          .prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC')
          .all(status)
      : this.#database.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all();
    return rows.map(approvalFromRow);
  }

  insertSandboxWithinLimit(sandbox: Sandbox, maxActiveSandboxes?: number): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (maxActiveSandboxes !== undefined) {
        const row = this.#database
          .prepare(
            "SELECT COUNT(*) AS count FROM sandboxes WHERE status IN ('creating', 'running', 'destroying')",
          )
          .get();
        if (Number(row?.count ?? 0) >= maxActiveSandboxes) {
          this.#database.exec('ROLLBACK');
          return false;
        }
      }
      this.#database
        .prepare(`INSERT INTO sandboxes
        (id, owner_id, workspace_id, runtime_name, runtime_root, status, endpoint, auth_token, error, created_at, last_activity_at, expires_at, destroyed_at, memory_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...this.#sandboxValues(sandbox));
      this.#database.exec('COMMIT');
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  saveSandbox(sandbox: Sandbox): void {
    this.#database
      .prepare(`UPDATE sandboxes SET
      owner_id = ?, workspace_id = ?, runtime_name = ?, runtime_root = ?, status = ?, endpoint = ?, auth_token = ?, error = ?,
      created_at = ?, last_activity_at = ?, expires_at = ?, destroyed_at = ?, memory_bytes = ? WHERE id = ?`)
      .run(...this.#sandboxValues(sandbox).slice(1), sandbox.id);
  }

  #sandboxValues(sandbox: Sandbox): SqlValue[] {
    return [
      sandbox.id,
      sandbox.ownerId,
      sandbox.workspaceId,
      sandbox.runtimeName,
      sandbox.runtimeRoot ?? null,
      sandbox.status,
      sandbox.endpoint ?? null,
      sandbox.authToken ?? null,
      sandbox.error ?? null,
      sandbox.createdAt,
      sandbox.lastActivityAt,
      sandbox.expiresAt,
      sandbox.destroyedAt ?? null,
      sandbox.memoryBytes ?? null,
    ];
  }

  getSandbox(id: string, ownerId?: string): Sandbox | undefined {
    const row = ownerId
      ? this.#database
          .prepare('SELECT * FROM sandboxes WHERE id = ? AND owner_id = ?')
          .get(id, ownerId)
      : this.#database.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id);
    return row ? sandboxFromRow(row) : undefined;
  }

  findActiveSandbox(ownerId: string, workspaceId: string): Sandbox | undefined {
    const row = this.#database
      .prepare(`SELECT * FROM sandboxes
      WHERE owner_id = ? AND workspace_id = ? AND status IN ('creating', 'running', 'destroying') ORDER BY created_at DESC LIMIT 1`)
      .get(ownerId, workspaceId);
    return row ? sandboxFromRow(row) : undefined;
  }

  listCurrentSandboxes(ownerId: string): readonly Sandbox[] {
    return this.#database
      .prepare(
        "SELECT * FROM sandboxes WHERE owner_id = ? AND status != 'destroyed' ORDER BY created_at DESC",
      )
      .all(ownerId)
      .map(sandboxFromRow);
  }

  listActiveSandboxes(): readonly Sandbox[] {
    return this.#database
      .prepare(
        "SELECT * FROM sandboxes WHERE status IN ('creating', 'running', 'destroying') ORDER BY created_at DESC",
      )
      .all()
      .map(sandboxFromRow);
  }

  countActiveSandboxes(): number {
    const row = this.#database
      .prepare(
        "SELECT COUNT(*) AS count FROM sandboxes WHERE status IN ('creating', 'running', 'destroying')",
      )
      .get();
    return Number(row?.count ?? 0);
  }

  listExpiredSandboxes(now: number): readonly Sandbox[] {
    return this.#database
      .prepare("SELECT * FROM sandboxes WHERE status = 'running' AND expires_at <= ?")
      .all(now)
      .map(sandboxFromRow);
  }
}
