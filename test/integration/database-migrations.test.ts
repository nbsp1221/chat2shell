import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, onTestFinished, test } from 'vitest';
import { StateDatabase } from '../../src/state/database.js';

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-migration-'));
  onTestFinished(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, 'chat2shell.sqlite');
}

function version(database: DatabaseSync): number {
  return Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

function columns(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

function createVersionZeroDatabase(file: string, includeMemory = false): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE sandboxes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      runtime_name TEXT NOT NULL UNIQUE,
      runtime_root TEXT,
      status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'destroying', 'destroyed', 'failed')),
      endpoint TEXT,
      auth_token TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      destroyed_at INTEGER${includeMemory ? ', memory_bytes INTEGER' : ''}
    );
    INSERT INTO sandboxes
      (id, owner_id, workspace_id, runtime_name, status, created_at, last_activity_at, expires_at)
    VALUES ('sbx_existing', 'owner', 'ws_existing', 'c2s-existing', 'failed', 1, 2, 3);
  `);
  database.close();
}

test('creates a fresh database at the latest schema version', () => {
  const file = databasePath();
  new StateDatabase(file).close();

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(2);
  expect(columns(database, 'sandboxes')).toContain('memory_bytes');
  database.close();
});

test('upgrades the version-zero production schema without losing existing rows', () => {
  const file = databasePath();
  createVersionZeroDatabase(file);

  const migrated = new StateDatabase(file);
  expect(migrated.getSandbox('sbx_existing')).toMatchObject({
    id: 'sbx_existing',
    memoryBytes: undefined,
    runtimeName: 'c2s-existing',
  });
  migrated.close();

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(2);
  expect(columns(database, 'sandboxes')).toContain('memory_bytes');
  expect(database.prepare('SELECT COUNT(*) AS count FROM sandboxes').get()?.count).toBe(1);
  database.close();

  new StateDatabase(file).close();
});

test('rolls back every pending migration and its version when one fails', () => {
  const file = databasePath();
  createVersionZeroDatabase(file, true);

  expect(() => new StateDatabase(file)).toThrow(/duplicate column name/);

  const database = new DatabaseSync(file, { readOnly: true });
  expect(version(database)).toBe(0);
  expect(
    database.prepare("SELECT name FROM sqlite_schema WHERE name = 'workspaces'").get(),
  ).toBeUndefined();
  database.close();
});

test('rejects a database created by a newer chat2shell version', () => {
  const file = databasePath();
  const database = new DatabaseSync(file);
  database.exec('PRAGMA user_version = 3');
  database.close();

  expect(() => new StateDatabase(file)).toThrow(/newer than supported version 2/);
});
