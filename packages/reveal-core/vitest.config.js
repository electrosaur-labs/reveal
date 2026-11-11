import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleThread: true,
      },
    },
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 60_000,
    teardownTimeout: 300_000,
    rpcTimeout: 600_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.js', 'index.js'],
      exclude: ['test/**'],
      // Set a few points below current actuals (2026-11-10: 75.8/81.8/71.6/75.8)
      // — enough slack for normal fluctuation, tight enough to catch a real
      // regression. Ratchet up over time as coverage improves; never lower
      // without a documented reason.
      thresholds: {
        statements: 70,
        branches: 75,
        functions: 65,
        lines: 70
      }
    }
  }
});
