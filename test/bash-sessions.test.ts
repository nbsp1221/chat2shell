import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BashSessionService } from "../src/codexpro/bash-sessions.js";

const execFileAsync = promisify(execFile);

class LocalBashExecutor {
  constructor(readonly cwd: string) {}

  async call(_ownerId: string, _sandboxId: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    assert.equal(toolName, "bash");
    const result = await execFileAsync("bash", ["-lc", String(args.command)], {
      cwd: typeof args.cwd === "string" ? path.join(this.cwd, args.cwd) : this.cwd,
      maxBuffer: 1024 * 1024,
    });
    return {
      content: [{ type: "text", text: result.stdout }],
      structuredContent: { exitCode: 0, stdout: result.stdout, stderr: result.stderr },
    };
  }
}

function sessionId(result: CallToolResult): string {
  const value = result.structuredContent?.session_id;
  if (typeof value !== "string") throw new Error("Missing session id");
  return value;
}

function cleanupSession(id: string): void {
  fs.rmSync(`/tmp/chat2shell-bash/${id}`, { recursive: true, force: true });
}

test("returns completed output for a short command", async (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const result = await sessions.start("owner", "sandbox", { command: "printf hello", yieldTimeMs: 1_000 });
  const id = sessionId(result);
  context.after(() => cleanupSession(id));

  assert.deepEqual(result.structuredContent, {
    session_id: id,
    status: "completed",
    exit_code: 0,
    output: "hello",
    has_more_output: false,
  });
});

test("returns a running session and only new output on continuation", async (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const started = await sessions.start("owner", "sandbox", {
    command: "printf first; sleep 0.4; printf second",
    yieldTimeMs: 100,
  });
  const id = sessionId(started);
  context.after(() => cleanupSession(id));
  assert.equal(started.structuredContent?.status, "running");
  assert.equal(started.structuredContent?.output, "first");

  await new Promise((resolve) => setTimeout(resolve, 500));
  const completed = await sessions.continue("owner", "sandbox", id);
  assert.equal(completed.structuredContent?.status, "completed");
  assert.equal(completed.structuredContent?.exit_code, 0);
  assert.equal(completed.structuredContent?.output, "second");

  const empty = await sessions.continue("owner", "sandbox", id);
  assert.equal(empty.structuredContent?.output, "");
});

test("stops the process group for a running session", async (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const started = await sessions.start("owner", "sandbox", { command: "printf ready; sleep 30", yieldTimeMs: 100 });
  const id = sessionId(started);
  context.after(() => cleanupSession(id));
  const stopped = await sessions.stop("owner", "sandbox", id);

  assert.equal(stopped.structuredContent?.status, "completed");
  assert.notEqual(stopped.structuredContent?.exit_code, 0);
});

test("applies an execution timeout only when requested", async (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const result = await sessions.start("owner", "sandbox", {
    command: "sleep 30",
    yieldTimeMs: 2_000,
    timeoutMs: 1_000,
  });
  const id = sessionId(result);
  context.after(() => cleanupSession(id));

  assert.equal(result.structuredContent?.status, "completed");
  assert.equal(result.structuredContent?.exit_code, 124);
});

test("returns large output in bounded consecutive chunks", async (context) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const first = await sessions.start("owner", "sandbox", {
    command: "head -c 70000 /dev/zero | tr '\\0' x",
    yieldTimeMs: 1_000,
  });
  const id = sessionId(first);
  context.after(() => cleanupSession(id));
  assert.equal((first.structuredContent?.output as string).length, 60_000);
  assert.equal(first.structuredContent?.has_more_output, true);

  const second = await sessions.continue("owner", "sandbox", id);
  assert.equal((second.structuredContent?.output as string).length, 10_000);
  assert.equal(second.structuredContent?.has_more_output, false);
});

test("forgets sessions when their sandbox is destroyed", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat2shell-bash-test-"));
  let destroyListener: ((sandboxId: string) => void) | undefined;
  const sessions = new BashSessionService(new LocalBashExecutor(cwd), (listener) => { destroyListener = listener; });
  const started = await sessions.start("owner", "sandbox", { command: "printf done", yieldTimeMs: 1_000 });
  const id = sessionId(started);
  cleanupSession(id);
  fs.rmSync(cwd, { recursive: true, force: true });

  destroyListener?.("sandbox");
  await assert.rejects(() => sessions.continue("owner", "sandbox", id), /Unknown Bash session/);
});
