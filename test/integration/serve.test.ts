import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { loadRuntimeConfig } from '../../src/config.js';
import { serve } from '../../src/runtime/serve.js';

test('makes an existing state directory owner-only before startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat2shell-serve-'));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir);
  await chmod(stateDir, 0o755);
  const config = {
    ...loadRuntimeConfig({
      CHAT2SHELL_DATA_ROOT: path.join(root, 'data'),
      CHAT2SHELL_ENABLE_TUNNEL: '0',
      CHAT2SHELL_STATE_DIR: stateDir,
    }),
    sbxBinary: path.join(root, 'missing-sbx'),
  };

  try {
    await expect(serve(config)).rejects.toThrow();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
