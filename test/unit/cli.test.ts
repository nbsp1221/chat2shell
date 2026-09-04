import { expect, test } from 'vitest';
import { createCli } from '../../src/cli/program.js';

test('exposes only the supported CLI commands', () => {
  expect(createCli().commands.map((command) => command.rawName)).toEqual([
    'setup',
    'serve',
    'status',
    'workspace list',
    'workspace add <path>',
    'approval list',
    'approval approve <id>',
    'approval reject <id>',
    'help [command]',
  ]);
});
