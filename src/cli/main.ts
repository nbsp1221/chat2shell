#!/usr/bin/env node

import { runCli } from './program.js';

runCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
