import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 60_000;
const OUTPUT_CHUNK_BYTES = 60_000;
const SESSION_ROOT = "/tmp/chat2shell-bash";

interface CodexProExecutor {
  call(ownerId: string, sandboxId: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

interface BashSession {
  readonly id: string;
  readonly ownerId: string;
  readonly sandboxId: string;
  readonly directory: string;
  outputOffset: number;
}

interface SessionStatus {
  readonly status: "running" | "completed";
  readonly exitCode: number | null;
  readonly outputSize: number;
}

export interface BashStartRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly yieldTimeMs?: number;
  readonly timeoutMs?: number;
}

function shellResult(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    const text = result.content.find((item) => item.type === "text")?.text ?? "CodexPro Bash failed";
    throw new Error(text);
  }
  if (!result.structuredContent) throw new Error("CodexPro Bash returned no structured result");
  const exitCode = result.structuredContent.exitCode;
  if (exitCode !== 0) {
    const stderr = result.structuredContent.stderr;
    throw new Error(typeof stderr === "string" && stderr.length > 0 ? stderr : `CodexPro Bash exited ${String(exitCode)}`);
  }
  return result.structuredContent;
}

function stdout(result: CallToolResult): string {
  const value = shellResult(result).stdout;
  if (typeof value !== "string") throw new Error("CodexPro Bash returned no stdout");
  return value;
}

function boundedInteger(name: string, value: number | undefined, fallback: number, maximum?: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || (maximum !== undefined && resolved > maximum)) {
    throw new Error(`${name} must be an integer from 0 to ${maximum ?? Number.MAX_SAFE_INTEGER}`);
  }
  return resolved;
}

function launchScript(session: BashSession, command: string, yieldTimeMs: number, timeoutMs: number | undefined): string {
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  const commandPath = `${session.directory}/command.sh`;
  const runnerPath = `${session.directory}/runner.sh`;
  const outputPath = `${session.directory}/output.log`;
  const exitPath = `${session.directory}/exit-code`;
  const executable = timeoutMs === undefined
    ? `setsid bash ${commandPath}`
    : `setsid timeout --signal=TERM --kill-after=2s ${(timeoutMs / 1_000).toFixed(3)}s bash ${commandPath}`;
  const runner = [
    "#!/usr/bin/env bash",
    "set +e",
    `${executable} >${outputPath} 2>&1 < /dev/null &`,
    "child=$!",
    `printf '%s\\n' \"$child\" >${session.directory}/pid`,
    "wait \"$child\"",
    "code=$?",
    `printf '%s\\n' \"$code\" >${exitPath}.tmp`,
    `mv ${exitPath}.tmp ${exitPath}`,
  ].join("\n");
  const encodedRunner = Buffer.from(runner, "utf8").toString("base64");
  const checks = Math.ceil(yieldTimeMs / 100);
  return [
    `install -d -m 700 ${SESSION_ROOT} ${session.directory}`,
    `printf '%s' '${encodedCommand}' | base64 -d >${commandPath}`,
    `printf '%s' '${encodedRunner}' | base64 -d >${runnerPath}`,
    `: >${outputPath}`,
    `nohup bash ${runnerPath} >/dev/null 2>&1 < /dev/null &`,
    checks > 0 ? `for ((i=0; i<${checks}; i++)); do [[ -f ${exitPath} ]] && break; sleep 0.1; done` : ":",
  ].join("\n");
}

export class BashSessionService {
  readonly #executor: CodexProExecutor;
  readonly #sessions = new Map<string, BashSession>();

  constructor(executor: CodexProExecutor, onSandboxDestroy?: (listener: (sandboxId: string) => void) => void) {
    this.#executor = executor;
    onSandboxDestroy?.((sandboxId) => this.forgetSandbox(sandboxId));
  }

  async start(ownerId: string, sandboxId: string, request: BashStartRequest): Promise<CallToolResult> {
    if (!request.command.trim()) throw new Error("command is required");
    const yieldTimeMs = boundedInteger("yield_time_ms", request.yieldTimeMs, DEFAULT_YIELD_MS, MAX_YIELD_MS);
    const timeoutMs = request.timeoutMs === undefined ? undefined : boundedInteger("timeout_ms", request.timeoutMs, 0);
    if (timeoutMs !== undefined && timeoutMs < 1_000) throw new Error("timeout_ms must be at least 1000");

    const id = `bash_${randomBytes(16).toString("hex")}`;
    const session: BashSession = {
      id,
      ownerId,
      sandboxId,
      directory: `${SESSION_ROOT}/${id}`,
      outputOffset: 0,
    };
    this.#sessions.set(id, session);
    try {
      shellResult(await this.#executor.call(ownerId, sandboxId, "bash", {
        command: launchScript(session, request.command, yieldTimeMs, timeoutMs),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        timeout_ms: Math.max(5_000, yieldTimeMs + 5_000),
      }));
      return await this.#snapshot(session);
    } catch (error) {
      this.#sessions.delete(id);
      throw error;
    }
  }

  async continue(ownerId: string, sandboxId: string, sessionId: string): Promise<CallToolResult> {
    return this.#snapshot(this.#get(ownerId, sandboxId, sessionId));
  }

  async stop(ownerId: string, sandboxId: string, sessionId: string): Promise<CallToolResult> {
    const session = this.#get(ownerId, sandboxId, sessionId);
    const command = [
      `for ((i=0; i<10 && ! -f ${session.directory}/pid && ! -f ${session.directory}/exit-code; i++)); do sleep 0.05; done`,
      `if [[ ! -f ${session.directory}/exit-code && -f ${session.directory}/pid ]]; then`,
      `  pid=$(cat ${session.directory}/pid)`,
      "  kill -TERM -- \"-$pid\" 2>/dev/null || true",
      "  for ((i=0; i<15; i++)); do kill -0 \"$pid\" 2>/dev/null || break; sleep 0.1; done",
      "  kill -KILL -- \"-$pid\" 2>/dev/null || true",
      "fi",
    ].join("\n");
    shellResult(await this.#executor.call(ownerId, sandboxId, "bash", { command, timeout_ms: 5_000 }));
    return this.#snapshot(session);
  }

  forgetSandbox(sandboxId: string): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.sandboxId === sandboxId) this.#sessions.delete(sessionId);
    }
  }

  async #snapshot(session: BashSession): Promise<CallToolResult> {
    const statusOutput = stdout(await this.#executor.call(session.ownerId, session.sandboxId, "bash", {
      command: [
        `if [[ -f ${session.directory}/exit-code ]]; then`,
        `  printf 'completed\\t%s\\t' \"$(cat ${session.directory}/exit-code)\"`,
        "else",
        "  printf 'running\\t-\\t'",
        "fi",
        `wc -c <${session.directory}/output.log`,
      ].join("\n"),
      timeout_ms: 5_000,
    }));
    const status = this.#parseStatus(statusOutput);
    const bytesToRead = Math.min(OUTPUT_CHUNK_BYTES, Math.max(0, status.outputSize - session.outputOffset));
    let output = "";
    if (bytesToRead > 0) {
      output = stdout(await this.#executor.call(session.ownerId, session.sandboxId, "bash", {
        command: `tail -c +${session.outputOffset + 1} ${session.directory}/output.log | head -c ${bytesToRead}`,
        timeout_ms: 5_000,
      }));
      session.outputOffset += bytesToRead;
    }
    const structuredContent = {
      session_id: session.id,
      status: status.status,
      exit_code: status.exitCode,
      output,
      has_more_output: status.outputSize > session.outputOffset,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
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
    const [status, exitCode, outputSize] = output.trim().split("\t");
    if ((status !== "running" && status !== "completed") || !outputSize || !/^\d+$/.test(outputSize)) {
      throw new Error("Invalid Bash session status");
    }
    if (status === "completed" && (!exitCode || !/^-?\d+$/.test(exitCode))) {
      throw new Error("Invalid Bash session exit code");
    }
    return {
      status,
      exitCode: status === "completed" ? Number(exitCode) : null,
      outputSize: Number(outputSize),
    };
  }
}
