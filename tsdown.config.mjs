import { defineConfig } from 'tsdown';

export default defineConfig({
  clean: true,
  entry: { cli: 'src/cli/main.ts' },
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});
