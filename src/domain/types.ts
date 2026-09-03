export type WorkspaceKind = 'managed' | 'host';
export type WorkspaceMode = 'managed' | 'clone' | 'direct';
export type WorkspaceStatus = 'approved' | 'retained' | 'trashed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type SandboxStatus = 'creating' | 'running' | 'destroying' | 'destroyed' | 'failed';

export interface Workspace {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: WorkspaceKind;
  readonly mode: WorkspaceMode;
  readonly root: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: number;
  readonly retainedUntil?: number;
}

export interface Approval {
  readonly id: string;
  readonly ownerId: string;
  readonly requestedPath: string;
  readonly mode: Exclude<WorkspaceMode, 'managed'>;
  readonly status: ApprovalStatus;
  readonly workspaceId?: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
}

export interface Sandbox {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly runtimeName: string;
  readonly runtimeRoot?: string;
  readonly status: SandboxStatus;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  readonly destroyedAt?: number;
}

export interface SandboxSummary {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly workspace: Workspace;
  readonly error?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  readonly destroyedAt?: number;
}

export interface SandboxCreateResult {
  readonly status: 'created' | 'reused' | 'approval_required';
  readonly sandbox?: SandboxSummary;
  readonly approval?: Approval;
}

export interface SandboxPortExposure {
  readonly sandboxId: string;
  readonly sandboxPort: number;
  readonly hostPort: number;
}
