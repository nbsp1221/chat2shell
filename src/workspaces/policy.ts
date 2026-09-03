import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const blockedNames = new Set([
  '.aws',
  '.azure',
  '.config',
  '.docker',
  '.gnupg',
  '.kube',
  '.local',
  '.secrets',
  '.ssh',
]);

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class HostPathPolicy {
  readonly #allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    this.#allowedRoots = allowedRoots.map((root) => fs.realpathSync.native(root));
  }

  resolveAndValidate(requestedPath: string): string {
    const expanded =
      requestedPath === '~'
        ? os.homedir()
        : requestedPath.startsWith('~/')
          ? path.join(os.homedir(), requestedPath.slice(2))
          : requestedPath;
    const resolved = fs.realpathSync.native(path.resolve(expanded));
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error('Workspace path must be a directory');
    }
    if (!this.#allowedRoots.some((root) => isInside(resolved, root))) {
      throw new Error(
        `Workspace must be below an allowed host root: ${this.#allowedRoots.join(', ')}`,
      );
    }
    const names = resolved.split(path.sep);
    const blocked = names.find((name) => blockedNames.has(name));
    if (blocked) {
      throw new Error(`Workspace path contains a protected directory: ${blocked}`);
    }
    return resolved;
  }
}
