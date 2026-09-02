import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StateDatabase } from "../src/state/database.js";

test("migrates the previous hard deadline and seven-day retention", (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-database-"));
  const databasePath = path.join(base, "state.sqlite");
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      root TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retained_until INTEGER,
      UNIQUE(owner_id, root, mode)
    );
    CREATE TABLE sandboxes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      runtime_name TEXT NOT NULL UNIQUE,
      runtime_root TEXT,
      status TEXT NOT NULL,
      endpoint TEXT,
      auth_token TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      max_expires_at INTEGER NOT NULL,
      destroyed_at INTEGER
    );
    INSERT INTO workspaces VALUES ('ws_legacy', 'owner', 'managed', 'managed', '/tmp/ws_legacy', 'retained', 0, 1000);
  `);
  legacy.close();

  new StateDatabase(databasePath).close();

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  const columns = migrated.prepare("PRAGMA table_info(sandboxes)").all() as Array<{ name: string }>;
  const workspace = migrated.prepare("SELECT retained_until FROM workspaces WHERE id = 'ws_legacy'").get() as { retained_until: number };
  migrated.close();

  assert.equal(columns.some((column) => column.name === "max_expires_at"), false);
  assert.equal(workspace.retained_until, 1000 + 23 * 24 * 60 * 60_000);
});
