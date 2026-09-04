import { expect, test } from 'vitest';
import { createCli } from '../../src/cli/program.js';

test('exposes only the supported CLI commands', () => {
  expect(createCli().commands.map((command) => command.rawName)).toEqual([
    'setup',
    'serve',
    'status',
    'workspace <action> [path]',
    'approval <action> [id]',
    'help [command]',
  ]);
});
