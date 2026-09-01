import path from "node:path";

export interface Workspace {
  readonly alias: string;
  readonly root: string;
}

export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, Workspace>();

  register(alias: string, root: string): Workspace {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
      throw new Error(`Invalid workspace alias: ${alias}`);
    }

    const workspace = { alias, root: path.resolve(root) };
    this.#workspaces.set(alias, workspace);
    return workspace;
  }

  resolve(alias: string): Workspace {
    const workspace = this.#workspaces.get(alias);
    if (!workspace) throw new Error(`Unknown workspace alias: ${alias}`);
    return workspace;
  }

  list(): readonly Workspace[] {
    return [...this.#workspaces.values()];
  }
}
