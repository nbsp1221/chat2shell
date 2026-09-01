import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace } from "../domain/types.js";

const execFileAsync = promisify(execFile);

interface SbxPort {
  readonly host_ip: string;
  readonly host_port: number;
  readonly sandbox_port: number;
  readonly protocol: string;
}

interface SbxListItem {
  readonly name: string;
  readonly status: string;
}

export interface RuntimeInfo {
  readonly name: string;
  readonly status: string;
}

export interface SandboxDriver {
  assertReady(): Promise<void>;
  create(runtimeName: string, workspace: Workspace): Promise<{ endpoint: string; runtimeRoot: string }>;
  startCodexPro(runtimeName: string, runtimeRoot: string, authToken: string, toolMode: string): Promise<void>;
  waitUntilHealthy(endpoint: string, authToken: string, timeoutMs?: number): Promise<void>;
  isHealthy(endpoint: string, authToken: string): Promise<boolean>;
  remove(runtimeName: string): Promise<void>;
  list(): Promise<readonly RuntimeInfo[]>;
}

export class SbxDriver implements SandboxDriver {
  readonly #binary: string;
  readonly #template: string;
  readonly #cpus: number;
  readonly #memory: string;
  readonly #sandboxPort: number;

  constructor(options: { binary: string; template: string; cpus: number; memory: string; sandboxPort: number }) {
    this.#binary = options.binary;
    this.#template = options.template;
    this.#cpus = options.cpus;
    this.#memory = options.memory;
    this.#sandboxPort = options.sandboxPort;
  }

  async assertReady(): Promise<void> {
    const { stdout } = await this.#run(["template", "ls", "--json"]);
    const images = JSON.parse(stdout) as { images: Array<{ repository: string; tag: string }> };
    const requested = this.#template.replace(/^docker\.io\/library\//, "");
    const present = images.images.some((image) => `${image.repository}:${image.tag}`.replace(/^docker\.io\/library\//, "") === requested);
    if (!present) throw new Error(`Missing sandbox template ${this.#template}. Run scripts/setup-template.sh first.`);
  }

  async create(runtimeName: string, workspace: Workspace): Promise<{ endpoint: string; runtimeRoot: string }> {
    const args = ["create", "--quiet", "--name", runtimeName, "--template", this.#template,
      "--cpus", String(this.#cpus), "--memory", this.#memory, "--publish", String(this.#sandboxPort)];
    if (workspace.mode === "clone") args.push("--clone");
    args.push("shell", workspace.root);
    await this.#run(args, 180_000);
    const [{ stdout: rootOutput }, { stdout: portsOutput }] = await Promise.all([
      this.#run(["exec", runtimeName, "pwd"]),
      this.#run(["ports", runtimeName, "--json"]),
    ]);
    const ports = JSON.parse(portsOutput) as SbxPort[];
    const port = ports.find((candidate) => candidate.host_ip === "127.0.0.1" && candidate.sandbox_port === this.#sandboxPort);
    if (!port) throw new Error(`Sandbox ${runtimeName} did not publish port ${this.#sandboxPort} on IPv4 loopback`);
    return { endpoint: `http://127.0.0.1:${port.host_port}/mcp`, runtimeRoot: rootOutput.trim() };
  }

  async startCodexPro(runtimeName: string, runtimeRoot: string, authToken: string, toolMode: string): Promise<void> {
    const command = "nohup codexpro-mcp-http --root \"$1\" --allow-root \"$1\" --host 0.0.0.0 --port \"$2\" --bash full --write workspace --tool-mode \"$3\" >/tmp/chat2shell-codexpro.log 2>&1 </dev/null &";
    await this.#run(["exec", "-e", `CODEXPRO_HTTP_TOKEN=${authToken}`, runtimeName, "sh", "-c", command,
      "chat2shell", runtimeRoot, String(this.#sandboxPort), toolMode]);
  }

  async waitUntilHealthy(endpoint: string, authToken: string, timeoutMs = 15_000): Promise<void> {
    const healthUrl = new URL("/healthz", endpoint);
    const deadline = Date.now() + timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl, {
          headers: { authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`CodexPro did not become healthy: ${lastError}`);
  }

  async isHealthy(endpoint: string, authToken: string): Promise<boolean> {
    try {
      return (await fetch(new URL("/healthz", endpoint), {
        headers: { authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(1_000),
      })).ok;
    } catch {
      return false;
    }
  }

  async remove(runtimeName: string): Promise<void> {
    if (!(await this.list()).some((runtime) => runtime.name === runtimeName)) return;
    await this.#run(["rm", "--force", runtimeName], 120_000);
  }

  async list(): Promise<readonly RuntimeInfo[]> {
    const { stdout } = await this.#run(["ls", "--json"]);
    const parsed = JSON.parse(stdout) as { sandboxes: SbxListItem[] };
    return parsed.sandboxes.map(({ name, status }) => ({ name, status }));
  }

  async #run(args: readonly string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.#binary, [...args], { encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string };
      throw new Error(`sbx ${args[0]} failed: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message}`);
    }
  }
}
