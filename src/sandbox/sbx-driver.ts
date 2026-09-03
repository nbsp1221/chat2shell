import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import type { Workspace } from '../domain/types.js';

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

export interface PublishedPort {
  readonly sandboxPort: number;
  readonly hostPort: number;
}

export interface SandboxDriver {
  assertReady(): Promise<void>;
  create(
    runtimeName: string,
    workspace: Workspace,
  ): Promise<{ endpoint: string; runtimeRoot: string }>;
  startCodexPro(runtimeName: string, runtimeRoot: string, authToken: string): Promise<void>;
  waitUntilHealthy(endpoint: string, authToken: string, timeoutMs?: number): Promise<void>;
  isHealthy(endpoint: string, authToken: string): Promise<boolean>;
  expose(runtimeName: string, sandboxPort: number): Promise<PublishedPort>;
  remove(runtimeName: string): Promise<void>;
  list(): Promise<readonly RuntimeInfo[]>;
}

export class SbxDriver implements SandboxDriver {
  readonly #binary: string;
  readonly #template: string;
  readonly #sandboxPort: number;
  readonly #codexProProcesses = new Map<string, ChildProcess>();

  constructor(options: { binary: string; template: string; sandboxPort: number }) {
    this.#binary = options.binary;
    this.#template = options.template;
    this.#sandboxPort = options.sandboxPort;
  }

  async assertReady(): Promise<void> {
    const { stdout } = await this.#run(['template', 'ls', '--json']);
    const images = JSON.parse(stdout) as { images: Array<{ repository: string; tag: string }> };
    const requested = this.#template.replace(/^docker\.io\/library\//, '');
    const present = images.images.some(
      (image) =>
        `${image.repository}:${image.tag}`.replace(/^docker\.io\/library\//, '') === requested,
    );
    if (!present) {
      throw new Error(
        `Missing sandbox template ${this.#template}. Run scripts/setup-template.sh first.`,
      );
    }
  }

  async create(
    runtimeName: string,
    workspace: Workspace,
  ): Promise<{ endpoint: string; runtimeRoot: string }> {
    const args = [
      'create',
      '--quiet',
      '--name',
      runtimeName,
      '--template',
      this.#template,
      '--publish',
      String(this.#sandboxPort),
      '--deny-network',
      'openrouter.ai',
    ];
    if (workspace.mode === 'clone') {
      args.push('--clone');
    }
    args.push('shell', workspace.root);
    await this.#run(args, 180_000);
    const [{ stdout: rootOutput }, { stdout: portsOutput }] = await Promise.all([
      this.#run(['exec', runtimeName, 'pwd']),
      this.#run(['ports', runtimeName, '--json']),
    ]);
    const ports = JSON.parse(portsOutput) as SbxPort[];
    const port = ports.find(
      (candidate) =>
        candidate.host_ip === '127.0.0.1' && candidate.sandbox_port === this.#sandboxPort,
    );
    if (!port) {
      throw new Error(
        `Sandbox ${runtimeName} did not publish port ${this.#sandboxPort} on IPv4 loopback`,
      );
    }
    return { endpoint: `http://127.0.0.1:${port.host_port}/mcp`, runtimeRoot: rootOutput.trim() };
  }

  async startCodexPro(runtimeName: string, runtimeRoot: string, authToken: string): Promise<void> {
    if (this.#codexProProcesses.has(runtimeName)) {
      throw new Error(`CodexPro is already running in ${runtimeName}`);
    }
    const child = spawn(
      this.#binary,
      [
        'exec',
        '-i',
        '-e',
        'CODEXPRO_HTTP_TOKEN',
        runtimeName,
        'codexpro-mcp-http',
        '--root',
        runtimeRoot,
        '--allow-root',
        runtimeRoot,
        '--host',
        '0.0.0.0',
        '--port',
        String(this.#sandboxPort),
        '--bash',
        'full',
        '--write',
        'workspace',
        '--tool-mode',
        'standard',
      ],
      {
        env: { ...process.env, CODEXPRO_HTTP_TOKEN: authToken },
        stdio: ['pipe', 'ignore', 'inherit'],
      },
    );
    this.#codexProProcesses.set(runtimeName, child);
    child.once('exit', () => {
      if (this.#codexProProcesses.get(runtimeName) === child) {
        this.#codexProProcesses.delete(runtimeName);
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }).catch((error) => {
      this.#codexProProcesses.delete(runtimeName);
      throw error;
    });
  }

  async waitUntilHealthy(endpoint: string, authToken: string, timeoutMs = 15_000): Promise<void> {
    const healthUrl = new URL('/healthz', endpoint);
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not ready';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(healthUrl, {
          headers: { authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
    }
    throw new Error(`CodexPro did not become healthy: ${lastError}`);
  }

  async isHealthy(endpoint: string, authToken: string): Promise<boolean> {
    try {
      return (
        await fetch(new URL('/healthz', endpoint), {
          headers: { authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(1_000),
        })
      ).ok;
    } catch {
      return false;
    }
  }

  async expose(runtimeName: string, sandboxPort: number): Promise<PublishedPort> {
    const existing = await this.#publishedPort(runtimeName, sandboxPort);
    if (existing) {
      return existing;
    }
    const hostPort = await this.#availableHostPort();
    await this.#run(['ports', runtimeName, '--publish', `0.0.0.0:${hostPort}:${sandboxPort}/tcp4`]);
    const published = await this.#publishedPort(runtimeName, sandboxPort);
    if (!published) {
      throw new Error(`Sandbox ${runtimeName} did not publish port ${sandboxPort}`);
    }
    return published;
  }

  async remove(runtimeName: string): Promise<void> {
    if ((await this.list()).some((runtime) => runtime.name === runtimeName)) {
      await this.#run(['rm', '--force', runtimeName], 120_000);
    }
    const child = this.#codexProProcesses.get(runtimeName);
    this.#codexProProcesses.delete(runtimeName);
    child?.kill('SIGTERM');
  }

  async list(): Promise<readonly RuntimeInfo[]> {
    const { stdout } = await this.#run(['ls', '--json']);
    const parsed = JSON.parse(stdout) as { sandboxes: SbxListItem[] };
    return parsed.sandboxes.map(({ name, status }) => ({ name, status }));
  }

  async #publishedPort(
    runtimeName: string,
    sandboxPort: number,
  ): Promise<PublishedPort | undefined> {
    const { stdout } = await this.#run(['ports', runtimeName, '--json']);
    const ports = JSON.parse(stdout) as SbxPort[];
    const port = ports.find(
      (candidate) =>
        candidate.host_ip === '0.0.0.0' &&
        candidate.sandbox_port === sandboxPort &&
        candidate.protocol === 'tcp4',
    );
    return port ? { sandboxPort: port.sandbox_port, hostPort: port.host_port } : undefined;
  }

  async #availableHostPort(): Promise<number> {
    const server = createServer();
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        server.close((error) => {
          if (error) {
            reject(error);
          } else if (!address || typeof address === 'string') {
            reject(new Error('Could not allocate a host port'));
          } else {
            resolve(address.port);
          }
        });
      });
    });
  }

  async #run(
    args: readonly string[],
    timeout = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.#binary, [...args], {
        encoding: 'utf8',
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string };
      throw new Error(
        `sbx ${args[0]} failed: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message}`,
        { cause: error },
      );
    }
  }
}
