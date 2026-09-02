import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateDatabase } from "../src/state/database.js";
import { WorkspaceService } from "../src/workspaces/service.js";

function fixture(context: test.TestContext): { base: string; database: StateDatabase; service: WorkspaceService } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-workspaces-"));
  const allowedRoot = path.join(base, "allowed");
  fs.mkdirSync(allowedRoot);
  const database = new StateDatabase(":memory:");
  const service = new WorkspaceService({
    database,
    dataRoot: path.join(base, "data"),
    workspaceRoot: path.join(base, "data", "workspaces"),
    allowedHostRoots: [allowedRoot],
    now: () => 1_000,
  });
  context.after(() => { database.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, database, service };
}

test("managed workspaces have an independent stable id and private directory", (context) => {
  const { service } = fixture(context);
  const workspace = service.createManaged("owner");
  assert.match(workspace.id, /^ws_/);
  assert.equal(path.basename(workspace.root), workspace.id);
  assert.equal(fs.statSync(workspace.root).mode & 0o777, 0o700);
});

test("a host path becomes only a pending approval until approved locally", (context) => {
  const { base, service } = fixture(context);
  const repository = path.join(base, "allowed", "repo");
  fs.mkdirSync(repository);
  const request = service.requestHost("owner", repository, "direct");
  assert.equal(request.status, "pending");
  assert.ok("requestedPath" in request);
  const workspace = service.approve(request.id);
  assert.equal(workspace.kind, "host");
  assert.equal(workspace.mode, "direct");
  assert.equal(workspace.root, repository);
});

test("paths outside allow roots and protected paths are rejected", (context) => {
  const { base, service } = fixture(context);
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  assert.throws(() => service.requestHost("owner", outside, "clone"), /allowed host root/);
  const protectedPath = path.join(base, "allowed", ".ssh", "repo");
  fs.mkdirSync(protectedPath, { recursive: true });
  assert.throws(() => service.requestHost("owner", protectedPath, "direct"), /protected directory/);
});

test("retained managed workspaces can be attached to a new sandbox before trashing", (context) => {
  const { service } = fixture(context);
  const workspace = service.createManaged("owner");
  service.retainManaged(workspace, 10_000);
  const restored = service.getApproved("owner", workspace.id);
  assert.equal(restored.status, "approved");
  assert.equal(restored.root, workspace.root);
});
