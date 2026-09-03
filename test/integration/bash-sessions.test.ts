import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, onTestFinished, test } from 'vitest';
import { BashSessionService } from '../../src/codexpro/bash-sessions.js';

const execFileAsync = promisify(execFile);

class LocalBashExecutor {
  constructor(
    readonly cwd: string,
    readonly transformOutput: (output: string) => string = (output) => output,
  ) {}

  async call(
    _ownerId: string,
    _sandboxId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    expect(toolName).toBe('bash');
    const result = await execFileAsync('bash', ['-lc', String(args.command)], {
      cwd: typeof args.cwd === 'string' ? path.join(this.cwd, args.cwd) : this.cwd,
      maxBuffer: 1024 * 1024,
    });
    const stdout = this.transformOutput(result.stdout);
    return {
      content: [{ type: 'text', text: stdout }],
      structuredContent: { exitCode: 0, stdout, stderr: result.stderr },
    };
  }
}

class SerializedBashExecutor {
  readonly executor: LocalBashExecutor;
  queue = Promise.resolve();

  constructor(cwd: string) {
    this.executor = new LocalBashExecutor(cwd);
  }

  call(
    ownerId: string,
    sandboxId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const result = this.queue.then(() => this.executor.call(ownerId, sandboxId, toolName, args));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function sessionId(result: CallToolResult): string {
  const value = result.structuredContent?.session_id;
  if (typeof value !== 'string') {
    throw new Error('Missing session id');
  }
  return value;
}

function cleanupSession(id: string): void {
  fs.rmSync(`/tmp/chat2shell-bash/${id}`, { recursive: true, force: true });
}

async function waitForSessionOutput(id: string, expected: string): Promise<void> {
  const outputPath = `/tmp/chat2shell-bash/${id}/output.log`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8').includes(expected)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for Bash session output: ${expected}`);
}

test('returns exited output for a short command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const result = await sessions.start('owner', 'sandbox', {
    command: 'printf hello',
    yieldTimeMs: 1_000,
  });
  const id = sessionId(result);
  onTestFinished(() => cleanupSession(id));

  expect(result.structuredContent).toEqual({
    session_id: id,
    status: 'exited',
    exit_code: 0,
    output: 'hello',
    has_more_output: false,
  });
});

test('returns a running session and long-polls for only new output', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const started = await sessions.start('owner', 'sandbox', {
    command: 'printf first; sleep 0.4; printf second',
    yieldTimeMs: 100,
  });
  const id = sessionId(started);
  onTestFinished(() => cleanupSession(id));
  expect(started.structuredContent?.status).toBe('running');
  expect(started.structuredContent?.output).toBe('first');

  const exited = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 1_000 });
  expect(exited.structuredContent?.status).toBe('exited');
  expect(exited.structuredContent?.exit_code).toBe(0);
  expect(exited.structuredContent?.output).toBe('second');

  const empty = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 });
  expect(empty.structuredContent?.output).toBe('');
});

test('stops the process group for a running session', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const started = await sessions.start('owner', 'sandbox', {
    command: 'printf ready; sleep 30',
    yieldTimeMs: 100,
  });
  const id = sessionId(started);
  onTestFinished(() => cleanupSession(id));
  const stopped = await sessions.stop('owner', 'sandbox', id);

  expect(stopped.structuredContent?.status).toBe('exited');
  expect(stopped.structuredContent?.exit_code).not.toBe(0);
});

test('applies an execution timeout only when requested', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const result = await sessions.start('owner', 'sandbox', {
    command: 'sleep 30',
    yieldTimeMs: 2_000,
    timeoutMs: 1_000,
  });
  const id = sessionId(result);
  onTestFinished(() => cleanupSession(id));

  expect(result.structuredContent?.status).toBe('exited');
  expect(result.structuredContent?.exit_code).toBe(124);
});

test('returns large output in bounded consecutive chunks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));

  const first = await sessions.start('owner', 'sandbox', {
    command: "head -c 70000 /dev/zero | tr '\\0' x",
    yieldTimeMs: 1_000,
  });
  const id = sessionId(first);
  onTestFinished(() => cleanupSession(id));
  expect(first.structuredContent?.output).toHaveLength(60_000);
  expect(first.structuredContent?.has_more_output).toBe(true);

  const second = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 });
  expect(second.structuredContent?.output).toHaveLength(10_000);
  expect(second.structuredContent?.has_more_output).toBe(false);
});

test('serializes concurrent polls without duplicating or losing output', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new SerializedBashExecutor(cwd));
  const started = await sessions.start('owner', 'sandbox', {
    command: 'sleep 0.2; printf unique; sleep 0.8; printf later',
    yieldTimeMs: 0,
  });
  const id = sessionId(started);
  onTestFinished(() => cleanupSession(id));
  await waitForSessionOutput(id, 'unique');

  const concurrent = await Promise.all([
    sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 }),
    sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 }),
  ]);
  const exited = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 1_000 });
  const output = [...concurrent, exited].map((result) => result.structuredContent?.output).join('');

  expect(output).toBe('uniquelater');
  expect(exited.structuredContent?.status).toBe('exited');
});

test('preserves UTF-8 characters across output chunks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));
  const expected = `${'a'.repeat(59_999)}😀`;
  const first = await sessions.start('owner', 'sandbox', {
    command: "printf '%*s' 59999 '' | tr ' ' a; printf '\\360\\237\\230\\200'",
    yieldTimeMs: 1_000,
  });
  const id = sessionId(first);
  onTestFinished(() => cleanupSession(id));
  const second = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 });

  expect(first.structuredContent?.has_more_output).toBe(true);
  expect(second.structuredContent?.has_more_output).toBe(false);
  expect(
    `${String(first.structuredContent?.output)}${String(second.structuredContent?.output)}`,
  ).toBe(expected);
});

test('waits for completion bytes instead of spinning on partial UTF-8', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessions = new BashSessionService(new LocalBashExecutor(cwd));
  const started = await sessions.start('owner', 'sandbox', {
    command: "printf '\\360'; sleep 1; printf '\\237\\230\\200'",
    yieldTimeMs: 100,
  });
  const id = sessionId(started);
  onTestFinished(() => cleanupSession(id));

  expect(started.structuredContent?.output).toBe('');
  expect(started.structuredContent?.has_more_output).toBe(false);
  const polled = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 2_000 });

  expect(polled.structuredContent?.status).toBe('exited');
  expect(polled.structuredContent?.output).toBe('😀');
});

test('returns exact sandbox output without cross-chunk redaction', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const redactPerCall = (output: string) =>
    output.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]');

  const sessions = new BashSessionService(new LocalBashExecutor(cwd, redactPerCall));
  const token = ['sk', '-', 'x'.repeat(20)].join('');
  const expected = `${'a'.repeat(59_997)}${token}`;
  const encoded = Buffer.from(expected).toString('base64');
  const first = await sessions.start('owner', 'sandbox', {
    command: `printf '%s' '${encoded}' | base64 -d`,
    yieldTimeMs: 1_000,
  });
  const id = sessionId(first);
  onTestFinished(() => cleanupSession(id));
  const second = await sessions.poll('owner', 'sandbox', id, { yieldTimeMs: 0 });

  expect(
    `${String(first.structuredContent?.output)}${String(second.structuredContent?.output)}`,
  ).toBe(expected);
});

test('forgets sessions when their sandbox is destroyed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2shell-bash-test-'));
  let destroyListener: ((sandboxId: string) => void) | undefined;
  const sessions = new BashSessionService(new LocalBashExecutor(cwd), (listener) => {
    destroyListener = listener;
  });
  const started = await sessions.start('owner', 'sandbox', {
    command: 'printf done',
    yieldTimeMs: 1_000,
  });
  const id = sessionId(started);
  cleanupSession(id);
  fs.rmSync(cwd, { recursive: true, force: true });

  destroyListener?.('sandbox');
  await expect(sessions.poll('owner', 'sandbox', id)).rejects.toThrow(/Unknown Bash session/);
});
