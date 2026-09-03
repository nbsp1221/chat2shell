import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text'],
    },
    projects: [
      {
        test: {
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          name: 'unit',
        },
      },
      {
        test: {
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          name: 'integration',
        },
      },
      {
        test: {
          environment: 'node',
          fileParallelism: false,
          hookTimeout: 30_000,
          include: ['test/e2e/**/*.test.ts'],
          name: 'e2e',
          testTimeout: 600_000,
        },
      },
    ],
  },
});
