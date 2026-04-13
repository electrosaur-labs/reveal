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
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 120_000,
    rpcTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.js', 'index.js'],
      exclude: ['test/**']
    }
  }
});
