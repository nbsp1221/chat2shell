import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  readonly version: number;
  readonly up: (database: DatabaseSync) => void;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
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
          destroyed_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_sandbox_per_workspace
          ON sandboxes(owner_id, workspace_id) WHERE status IN ('creating', 'running', 'destroying');
      `);
    },
  },
  {
    version: 2,
    up(database) {
      database.exec('ALTER TABLE sandboxes ADD COLUMN memory_bytes INTEGER');
    },
  },
];

const latestVersion = migrations.length;

function readVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

function assertSupported(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid database schema version: ${String(version)}`);
  }
  if (version > latestVersion) {
    throw new Error(
      `Database schema version ${version} is newer than supported version ${latestVersion}`,
    );
  }
}

export function migrate(database: DatabaseSync): void {
  const observedVersion = readVersion(database);
  assertSupported(observedVersion);
  if (observedVersion === latestVersion) {
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const currentVersion = readVersion(database);
    assertSupported(currentVersion);
    for (const migration of migrations.slice(currentVersion)) {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error if SQLite already ended the transaction.
    }
    throw error;
  }
}
