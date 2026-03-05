import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
  resolve: {
    alias: {
      '@electrosaur-labs/core': path.resolve(__dirname, '../reveal-core'),
    }
  }
});
