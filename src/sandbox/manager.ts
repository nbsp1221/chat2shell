export type SandboxStatus = "creating" | "running" | "stopped" | "failed";

export interface Sandbox {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly workspaceAlias?: string;
}

export interface CreateSandboxRequest {
  readonly workspaceAlias?: string;
}

export interface SandboxManager {
  create(request: CreateSandboxRequest): Promise<Sandbox>;
  stop(id: string): Promise<Sandbox>;
  list(): Promise<readonly Sandbox[]>;
}
