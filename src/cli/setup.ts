import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeConfig } from '../config.js';

const execFileAsync = promisify(execFile);

interface TemplateImage {
  readonly repository: string;
  readonly tag: string;
}

function normalizedImage(value: string): string {
  return value.replace(/^docker\.io\/library\//, '');
}

async function templateExists(config: RuntimeConfig): Promise<boolean> {
  const { stdout } = await execFileAsync(config.sbxBinary, ['template', 'ls', '--json']);
  const parsed = JSON.parse(stdout) as { images: TemplateImage[] };
  return parsed.images.some(
    (image) => normalizedImage(`${image.repository}:${image.tag}`) === config.sandboxTemplate,
  );
}

async function assertTunnelFiles(config: RuntimeConfig): Promise<void> {
  if (!config.tunnelEnabled) {
    return;
  }
  for (const requiredPath of [config.tunnelClient, config.tunnelKeyPath, config.tunnelIdPath]) {
    try {
      await access(requiredPath);
    } catch {
      throw new Error(`Missing required tunnel file: ${requiredPath}`);
    }
  }
}

export async function setup(config: RuntimeConfig): Promise<void> {
  await assertTunnelFiles(config);
  await execFileAsync(config.sbxBinary, ['version']);
  if (await templateExists(config)) {
    console.log(`Sandbox template ready: ${config.sandboxTemplate}`);
    console.log('chat2shell setup complete');
    return;
  }

  const bootstrapDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat2shell-template-'));
  const bootstrapName = `c2s-template-${Date.now()}`;
  const codexProVersion = config.sandboxTemplate.split(':').at(-1);
  if (!codexProVersion) {
    throw new Error(`Sandbox template has no CodexPro version: ${config.sandboxTemplate}`);
  }
  try {
    console.log(`Creating sandbox template: ${config.sandboxTemplate}`);
    await execFileAsync(config.sbxBinary, [
      'create',
      '--quiet',
      '--name',
      bootstrapName,
      'shell',
      bootstrapDirectory,
    ]);
    await execFileAsync(config.sbxBinary, [
      'exec',
      '-u',
      'root',
      bootstrapName,
      'npm',
      'install',
      '--global',
      '--omit=dev',
      `codexpro@${codexProVersion}`,
    ]);
    await execFileAsync(config.sbxBinary, ['stop', bootstrapName]);
    await execFileAsync(config.sbxBinary, [
      'template',
      'save',
      bootstrapName,
      config.sandboxTemplate,
    ]);
  } finally {
    await execFileAsync(config.sbxBinary, ['rm', '--force', bootstrapName]).catch(() => undefined);
    await rm(bootstrapDirectory, { force: true, recursive: true });
  }
  console.log(`Sandbox template ready: ${config.sandboxTemplate}`);
  console.log('chat2shell setup complete');
}
