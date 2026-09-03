import { randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 60_000;
const OUTPUT_CHUNK_BYTES = 60_000;
const SESSION_ROOT = '/tmp/chat2shell-bash';

interface CodexProExecutor {
  call(
    ownerId: string,
    sandboxId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

interface BashSession {
  readonly id: string;
  readonly ownerId: string;
  readonly sandboxId: string;
  readonly directory: string;
  readOffset: number;
  pendingOutput: Buffer;
  snapshotQueue: Promise<void>;
}

interface SessionStatus {
  readonly status: 'running' | 'exited';
  readonly exitCode: number | null;
  readonly outputSize: number;
}

export interface BashStartRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly yieldTimeMs?: number;
  readonly timeoutMs?: number;
}

export interface BashPollRequest {
  readonly yieldTimeMs?: number;
}

function shellResult(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    const text =
      result.content.find((item) => item.type === 'text')?.text ?? 'CodexPro Bash failed';
    throw new Error(text);
  }
  if (!result.structuredContent) {
    throw new Error('CodexPro Bash returned no structured result');
  }
  const exitCode = result.structuredContent.exitCode;
  if (exitCode !== 0) {
    const stderr = result.structuredContent.stderr;
    throw new Error(
      typeof stderr === 'string' && stderr.length > 0
        ? stderr
        : `CodexPro Bash exited ${String(exitCode)}`,
    );
  }
  return result.structuredContent;
}

function stdout(result: CallToolResult): string {
  const value = shellResult(result).stdout;
  if (typeof value !== 'string') {
    throw new Error('CodexPro Bash returned no stdout');
  }
  return value;
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum?: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    (maximum !== undefined && resolved > maximum)
  ) {
    throw new Error(`${name} must be an integer from 0 to ${maximum ?? Number.MAX_SAFE_INTEGER}`);
  }
  return resolved;
}

function completeUtf8PrefixLength(bytes: Buffer, finalChunk: boolean): number {
  if (finalChunk || bytes.length === 0) {
    return bytes.length;
  }
  let leadIndex = bytes.length - 1;
  while (leadIndex >= 0 && (bytes[leadIndex]! & 0xc0) === 0x80) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) {
    return bytes.length;
  }
  const lead = bytes[leadIndex]!;
  let expectedLength = 1;
  if (lead >= 0xc2 && lead <= 0xdf) {
    expectedLength = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    expectedLength = 3;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    expectedLength = 4;
  }
  return bytes.length - leadIndex < expectedLength ? leadIndex : bytes.length;
}

function launchScript(
  session: BashSession,
  command: string,
  yieldTimeMs: number,
  timeoutMs: number | undefined,
): string {
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  const commandPath = `${session.directory}/command.sh`;
  const runnerPath = `${session.directory}/runner.sh`;
  const outputPath = `${session.directory}/output.log`;
  const exitPath = `${session.directory}/exit-code`;
  const executable =
    timeoutMs === undefined
      ? `setsid bash ${commandPath}`
      : `setsid timeout --signal=TERM --kill-after=2s ${(timeoutMs / 1_000).toFixed(3)}s bash ${commandPath}`;
  const runner = [
    '#!/usr/bin/env bash',
    'set +e',
    `${executable} >${outputPath} 2>&1 < /dev/null &`,
    'child=$!',
    `printf '%s\\n' "$child" >${session.directory}/pid`,
    'wait "$child"',
    'code=$?',
    `printf '%s\\n' "$code" >${exitPath}.tmp`,
    `mv ${exitPath}.tmp ${exitPath}`,
  ].join('\n');
  const encodedRunner = Buffer.from(runner, 'utf8').toString('base64');
  const checks = Math.ceil(yieldTimeMs / 100);
  return [
    `install -d -m 700 ${SESSION_ROOT} ${session.directory}`,
    `printf '%s' '${encodedCommand}' | base64 -d >${commandPath}`,
    `printf '%s' '${encodedRunner}' | base64 -d >${runnerPath}`,
    `: >${outputPath}`,
    `nohup bash ${runnerPath} >/dev/null 2>&1 < /dev/null &`,
    checks > 0
      ? `for ((i=0; i<${checks}; i++)); do [[ -f ${exitPath} ]] && break; sleep 0.1; done`
      : ':',
  ].join('\n');
}

export class BashSessionService {
  readonly #executor: CodexProExecutor;
  readonly #sessions = new Map<string, BashSession>();

  constructor(
    executor: CodexProExecutor,
    onSandboxDestroy?: (listener: (sandboxId: string) => void) => void,
  ) {
    this.#executor = executor;
    onSandboxDestroy?.((sandboxId) => this.forgetSandbox(sandboxId));
  }

  async start(
    ownerId: string,
    sandboxId: string,
    request: BashStartRequest,
  ): Promise<CallToolResult> {
    if (!request.command.trim()) {
      throw new Error('command is required');
    }
    const yieldTimeMs = boundedInteger(
      'yield_time_ms',
      request.yieldTimeMs,
      DEFAULT_YIELD_MS,
      MAX_YIELD_MS,
    );
    const timeoutMs =
      request.timeoutMs === undefined
        ? undefined
        : boundedInteger('timeout_ms', request.timeoutMs, 0);
    if (timeoutMs !== undefined && timeoutMs < 1_000) {
      throw new Error('timeout_ms must be at least 1000');
    }

    const id = `bash_${randomBytes(16).toString('hex')}`;
    const session: BashSession = {
      id,
      ownerId,
      sandboxId,
      directory: `${SESSION_ROOT}/${id}`,
      readOffset: 0,
      pendingOutput: Buffer.alloc(0),
      snapshotQueue: Promise.resolve(),
    };
    this.#sessions.set(id, session);
    try {
      shellResult(
        await this.#executor.call(ownerId, sandboxId, 'bash', {
          command: launchScript(session, request.command, yieldTimeMs, timeoutMs),
          ...(request.cwd ? { cwd: request.cwd } : {}),
          timeout_ms: Math.max(5_000, yieldTimeMs + 5_000),
        }),
      );
    } catch (error) {
      this.#sessions.delete(id);
      throw error;
    }

    try {
      return await this.#snapshot(session);
    } catch {
      return this.#unobservedStart(session);
    }
  }

  async poll(
    ownerId: string,
    sandboxId: string,
    sessionId: string,
    request: BashPollRequest = {},
  ): Promise<CallToolResult> {
    const yieldTimeMs = boundedInteger(
      'yield_time_ms',
      request.yieldTimeMs,
      DEFAULT_YIELD_MS,
      MAX_YIELD_MS,
    );
    return this.#snapshot(this.#get(ownerId, sandboxId, sessionId), yieldTimeMs);
  }

  async stop(ownerId: string, sandboxId: string, sessionId: string): Promise<CallToolResult> {
    const session = this.#get(ownerId, sandboxId, sessionId);
    const command = [
      `for ((i=0; i<10 && ! -f ${session.directory}/pid && ! -f ${session.directory}/exit-code; i++)); do sleep 0.05; done`,
      `if [[ ! -f ${session.directory}/exit-code && -f ${session.directory}/pid ]]; then`,
      `  pid=$(cat ${session.directory}/pid)`,
      '  kill -TERM -- "-$pid" 2>/dev/null || true',
      '  for ((i=0; i<15; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done',
      '  kill -KILL -- "-$pid" 2>/dev/null || true',
      'fi',
    ].join('\n');
    shellResult(
      await this.#executor.call(ownerId, sandboxId, 'bash', { command, timeout_ms: 5_000 }),
    );
    return this.#snapshot(session);
  }

  forgetSandbox(sandboxId: string): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.sandboxId === sandboxId) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  #unobservedStart(session: BashSession): CallToolResult {
    const structuredContent = {
      session_id: session.id,
      status: 'running',
      exit_code: null,
      output: '',
      has_more_output: false,
    };
    return {
      content: [
        {
          type: 'text',
          text: `Bash session ${session.id} started, but its initial snapshot was unavailable. Poll it with bash_poll.`,
        },
      ],
      structuredContent,
    };
  }

  async #snapshot(session: BashSession, yieldTimeMs = 0): Promise<CallToolResult> {
    const result = session.snapshotQueue.then(() => this.#readSnapshot(session, yieldTimeMs));
    session.snapshotQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readSnapshot(session: BashSession, yieldTimeMs: number): Promise<CallToolResult> {
    const checks = Math.ceil(yieldTimeMs / 100);
    const statusOutput = stdout(
      await this.#executor.call(session.ownerId, session.sandboxId, 'bash', {
        command: [
          checks > 0
            ? `for ((i=0; i<${checks}; i++)); do [[ -f ${session.directory}/exit-code ]] && break; [[ $(wc -c <${session.directory}/output.log) -gt ${session.readOffset} ]] && break; sleep 0.1; done`
            : ':',
          `if [[ -f ${session.directory}/exit-code ]]; then`,
          `  printf 'exited\\t%s\\t' "$(cat ${session.directory}/exit-code)"`,
          'else',
          "  printf 'running\\t-\\t'",
          'fi',
          `wc -c <${session.directory}/output.log`,
        ].join('\n'),
        timeout_ms: Math.max(5_000, yieldTimeMs + 5_000),
      }),
    );
    const status = this.#parseStatus(statusOutput);
    const bytesToRead = Math.min(
      OUTPUT_CHUNK_BYTES,
      Math.max(0, status.outputSize - session.readOffset),
    );
    if (bytesToRead > 0) {
      const encoded = stdout(
        await this.#executor.call(session.ownerId, session.sandboxId, 'bash', {
          command: `tail -c +${session.readOffset + 1} ${session.directory}/output.log | head -c ${bytesToRead} | base64 -w 0`,
          timeout_ms: 5_000,
        }),
      );
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== bytesToRead) {
        throw new Error('Invalid encoded Bash output');
      }
      session.readOffset += bytes.length;
      session.pendingOutput = Buffer.concat([session.pendingOutput, bytes]);
    }
    const prefixLength = completeUtf8PrefixLength(
      session.pendingOutput,
      status.status === 'exited' && status.outputSize === session.readOffset,
    );
    const output = session.pendingOutput.subarray(0, prefixLength).toString('utf8');
    const pendingOutput = Buffer.alloc(session.pendingOutput.length - prefixLength);
    session.pendingOutput.copy(pendingOutput, 0, prefixLength);
    session.pendingOutput = pendingOutput;
    const structuredContent = {
      session_id: session.id,
      status: status.status,
      exit_code: status.exitCode,
      output,
      has_more_output: status.outputSize > session.readOffset,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  }

  #get(ownerId: string, sandboxId: string, sessionId: string): BashSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId || session.sandboxId !== sandboxId) {
      throw new Error(`Unknown Bash session: ${sessionId}`);
    }
    return session;
  }

  #parseStatus(output: string): SessionStatus {
    const [status, exitCode, outputSize] = output.trim().split('\t');
    if ((status !== 'running' && status !== 'exited') || !outputSize || !/^\d+$/.test(outputSize)) {
      throw new Error('Invalid Bash session status');
    }
    if (status === 'exited' && (!exitCode || !/^-?\d+$/.test(exitCode))) {
      throw new Error('Invalid Bash session exit code');
    }
    return {
      status,
      exitCode: status === 'exited' ? Number(exitCode) : null,
      outputSize: Number(outputSize),
    };
  }
}
